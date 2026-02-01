import WebSocket from "ws";
import path from "node:path";
import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent } from "./types.js";
import { StreamState } from "./types.js";
import { getAccessToken, getGatewayUrl, sendC2CMessage, sendChannelMessage, sendGroupMessage, clearTokenCache, sendC2CImageMessage, sendGroupImageMessage, initApiConfig, startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from "./api.js";
import { loadSession, saveSession, clearSession, type SessionState } from "./session-store.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { startImageServer, saveImage, saveImageFromPath, isImageServerRunning, downloadFile, type ImageServerConfig } from "./image-server.js";
import { createStreamSender } from "./outbound.js";

// QQ Bot intents - 按权限级别分组
const INTENTS = {
  // 基础权限（默认有）
  GUILDS: 1 << 0,                    // 频道相关
  GUILD_MEMBERS: 1 << 1,             // 频道成员
  PUBLIC_GUILD_MESSAGES: 1 << 30,    // 频道公开消息（公域）
  // 需要申请的权限
  DIRECT_MESSAGE: 1 << 12,           // 频道私信
  GROUP_AND_C2C: 1 << 25,            // 群聊和 C2C 私聊（需申请）
};

// 权限级别：从高到低依次尝试
const INTENT_LEVELS = [
  // Level 0: 完整权限（群聊 + 私信 + 频道）
  {
    name: "full",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C,
    description: "群聊+私信+频道",
  },
  // Level 1: 群聊 + 频道（无私信）
  {
    name: "group+channel",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
    description: "群聊+频道",
  },
  // Level 2: 仅频道（基础权限）
  {
    name: "channel-only",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GUILD_MEMBERS,
    description: "仅频道消息",
  },
];

// 重连配置
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // 递增延迟
const RATE_LIMIT_DELAY = 60000; // 遇到频率限制时等待 60 秒
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_QUICK_DISCONNECT_COUNT = 3; // 连续快速断开次数阈值
const QUICK_DISCONNECT_THRESHOLD = 5000; // 5秒内断开视为快速断开

// 图床服务器配置（可通过环境变量覆盖）
const IMAGE_SERVER_PORT = parseInt(process.env.QQBOT_IMAGE_SERVER_PORT || "18765", 10);
// 使用绝对路径，确保文件保存和读取使用同一目录
const IMAGE_SERVER_DIR = process.env.QQBOT_IMAGE_SERVER_DIR || path.join(process.env.HOME || "/home/ubuntu", "clawd", "qqbot-images");

// 流式消息配置
const STREAM_CHUNK_INTERVAL = 500; // 流式消息分片间隔（毫秒）
const STREAM_MIN_CHUNK_SIZE = 10; // 最小分片大小（字符）
const STREAM_KEEPALIVE_FIRST_DELAY = 3000; // 首次状态保持延迟（毫秒），openclaw 3s 内未回复时发送
const STREAM_KEEPALIVE_GAP = 10000; // 状态保持消息之间的间隔（毫秒）
const STREAM_KEEPALIVE_MAX_PER_CHUNK = 2; // 每 2 个消息分片之间最多发送的状态保持消息数量
const STREAM_MAX_DURATION = 3 * 60 * 1000; // 流式消息最大持续时间（毫秒），超过 3 分钟自动结束

// 消息队列配置（异步处理，防止阻塞心跳）
const MESSAGE_QUEUE_SIZE = 1000; // 最大队列长度
const MESSAGE_QUEUE_WARN_THRESHOLD = 800; // 队列告警阈值

// ============ 消息回复限流器 ============
// 同一 message_id 1小时内最多回复 4 次，超过1小时需降级为主动消息
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1小时

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

/**
 * 检查是否可以回复该消息（限流检查）
 * @param messageId 消息ID
 * @returns { allowed: boolean, remaining: number } allowed=是否允许回复，remaining=剩余次数
 */
function checkMessageReplyLimit(messageId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  // 清理过期记录（定期清理，避免内存泄漏）
  if (messageReplyTracker.size > 10000) {
    for (const [id, rec] of messageReplyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        messageReplyTracker.delete(id);
      }
    }
  }
  
  if (!record) {
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }
  
  // 检查是否过期
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    messageReplyTracker.delete(messageId);
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }
  
  // 检查是否超过限制
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

/**
 * 记录一次消息回复
 * @param messageId 消息ID
 */
function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  if (!record) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    // 检查是否过期，过期则重新计数
    if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
      messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      record.count++;
    }
  }
}

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * 消息队列项类型（用于异步处理消息，防止阻塞心跳）
 */
interface QueuedMessage {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string }>;
}

/**
 * 启动图床服务器
 */
async function ensureImageServer(log?: GatewayContext["log"], publicBaseUrl?: string): Promise<string | null> {
  if (isImageServerRunning()) {
    return publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`;
  }

  try {
    const config: Partial<ImageServerConfig> = {
      port: IMAGE_SERVER_PORT,
      storageDir: IMAGE_SERVER_DIR,
      // 使用用户配置的公网地址，而不是 0.0.0.0
      baseUrl: publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`,
      ttlSeconds: 3600, // 1 小时过期
    };
    await startImageServer(config);
    log?.info(`[qqbot] Image server started on port ${IMAGE_SERVER_PORT}, baseUrl: ${config.baseUrl}`);
    return config.baseUrl!;
  } catch (err) {
    log?.error(`[qqbot] Failed to start image server: ${err}`);
    return null;
  }
}

/**
 * 启动 Gateway WebSocket 连接（带自动重连）
 * 支持流式消息发送
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  // 初始化 API 配置（markdown 支持）
  initApiConfig({
    markdownSupport: account.markdownSupport,
  });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport !== false}`);

  // 如果配置了公网 URL，启动图床服务器
  let imageServerBaseUrl: string | null = null;
  if (account.imageServerBaseUrl) {
    // 使用用户配置的公网地址作为 baseUrl
    await ensureImageServer(log, account.imageServerBaseUrl);
    imageServerBaseUrl = account.imageServerBaseUrl;
    log?.info(`[qqbot:${account.accountId}] Image server enabled with URL: ${imageServerBaseUrl}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] Image server disabled (no imageServerBaseUrl configured)`);
  }

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime: number = 0; // 上次连接成功的时间
  let quickDisconnectCount = 0; // 连续快速断开次数
  let isConnecting = false; // 防止并发连接
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // 重连定时器
  let shouldRefreshToken = false; // 下次连接是否需要刷新 token
  let intentLevelIndex = 0; // 当前尝试的权限级别索引
  let lastSuccessfulIntentLevel = -1; // 上次成功的权限级别

  // ============ P1-2: 尝试从持久化存储恢复 Session ============
  const savedSession = loadSession(account.accountId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    intentLevelIndex = savedSession.intentLevelIndex;
    lastSuccessfulIntentLevel = savedSession.intentLevelIndex;
    log?.info(`[qqbot:${account.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}, intentLevel=${intentLevelIndex}`);
  }

  // ============ 消息队列（异步处理，防止阻塞心跳） ============
  const messageQueue: QueuedMessage[] = [];
  let messageProcessorRunning = false;
  let messagesProcessed = 0; // 统计已处理消息数

  /**
   * 将消息加入队列（非阻塞）
   */
  const enqueueMessage = (msg: QueuedMessage): void => {
    if (messageQueue.length >= MESSAGE_QUEUE_SIZE) {
      // 队列满了，丢弃最旧的消息
      const dropped = messageQueue.shift();
      log?.error(`[qqbot:${account.accountId}] Message queue full, dropping oldest message from ${dropped?.senderId}`);
    }
    if (messageQueue.length >= MESSAGE_QUEUE_WARN_THRESHOLD) {
      log?.info(`[qqbot:${account.accountId}] Message queue size: ${messageQueue.length}/${MESSAGE_QUEUE_SIZE}`);
    }
    messageQueue.push(msg);
    log?.debug?.(`[qqbot:${account.accountId}] Message enqueued, queue size: ${messageQueue.length}`);
  };

  /**
   * 启动消息处理循环（独立于 WS 消息循环）
   */
  const startMessageProcessor = (handleMessageFn: (msg: QueuedMessage) => Promise<void>): void => {
    if (messageProcessorRunning) return;
    messageProcessorRunning = true;

    const processLoop = async () => {
      while (!isAborted) {
        if (messageQueue.length === 0) {
          // 队列为空，等待一小段时间
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }

        const msg = messageQueue.shift()!;
        try {
          await handleMessageFn(msg);
          messagesProcessed++;
        } catch (err) {
          // 捕获处理异常，防止影响队列循环
          log?.error(`[qqbot:${account.accountId}] Message processor error: ${err}`);
        }
      }
      messageProcessorRunning = false;
      log?.info(`[qqbot:${account.accountId}] Message processor stopped`);
    };

    // 异步启动，不阻塞调用者
    processLoop().catch(err => {
      log?.error(`[qqbot:${account.accountId}] Message processor crashed: ${err}`);
      messageProcessorRunning = false;
    });

    log?.info(`[qqbot:${account.accountId}] Message processor started`);
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
    // P1-1: 停止后台 Token 刷新
    stopBackgroundTokenRefresh();
    // P1-3: 保存已知用户数据
    flushKnownUsers();
  });

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => {
    const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
    return RECONNECT_DELAYS[idx];
  };

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[qqbot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }

    // 取消已有的重连定时器
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(`[qqbot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) {
        connect();
      }
    }, delay);
  };

  const connect = async () => {
    // 防止并发连接
    if (isConnecting) {
      log?.debug?.(`[qqbot:${account.accountId}] Already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();

      // 如果标记了需要刷新 token，则清除缓存
      if (shouldRefreshToken) {
        log?.info(`[qqbot:${account.accountId}] Refreshing token...`);
        clearTokenCache();
        shouldRefreshToken = false;
      }
      
      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      const gatewayUrl = await getGatewayUrl(accessToken);

      log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl);
      currentWs = ws;

      const pluginRuntime = getQQBotRuntime();

      // 处理收到的消息
      const handleMessage = async (event: {
        type: "c2c" | "guild" | "dm" | "group";
        senderId: string;
        senderName?: string;
        content: string;
        messageId: string;
        timestamp: string;
        channelId?: string;
        guildId?: string;
        groupOpenid?: string;
        attachments?: Array<{ content_type: string; url: string; filename?: string }>;
      }) => {
        log?.info(`[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`);
        if (event.attachments?.length) {
          log?.info(`[qqbot:${account.accountId}] Attachments: ${event.attachments.length}`);
        }

        // 流式消息开关（默认启用，仅 c2c 支持）
        const streamEnabled = account.streamEnabled !== false;
        log?.debug?.(`[qqbot:${account.accountId}] Stream enabled: ${streamEnabled}`);

        pluginRuntime.channel.activity.record({
          channel: "qqbot",
          accountId: account.accountId,
          direction: "inbound",
        });

        const isGroup = event.type === "guild" || event.type === "group";
        const peerId = event.type === "guild" ? `channel:${event.channelId}` 
                     : event.type === "group" ? `group:${event.groupOpenid}`
                     : event.senderId;

        const route = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: {
            kind: isGroup ? "group" : "dm",
            id: peerId,
          },
        });

        const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

        // 组装消息体，添加系统提示词
        let builtinPrompt = "";
        
        // ============ 用户标识信息（用于定时提醒和主动消息） ============
        const isGroupChat = event.type === "group";
        const targetAddress = isGroupChat ? `group:${event.groupOpenid}` : event.senderId;
        
        builtinPrompt += `
【当前用户信息】
- 用户 openid: ${event.senderId}
- 用户昵称: ${event.senderName || "未知"}
- 消息类型: ${isGroupChat ? "群聊" : "私聊"}
- 当前消息 message_id: ${event.messageId}${isGroupChat ? `
- 群组 group_openid: ${event.groupOpenid}` : ""}

【定时提醒能力】
你可以帮助用户设置定时提醒。使用 openclaw cron 命令：

示例：5分钟后提醒用户喝水
\`\`\`bash
openclaw cron add \\
  --name "提醒喝水-${event.senderName || "用户"}" \\
  --at "5m" \\
  --session isolated \\
  --message "💧 该喝水啦！" \\
  --deliver \\
  --channel qqbot \\
  --to "${targetAddress}" \\
  --reply-to "${event.messageId}" \\
  --delete-after-run
\`\`\`

关键参数说明：
- \`--to\`: 目标地址（当前用户: ${targetAddress}）
- \`--reply-to\`: 回复消息ID（当前消息: ${event.messageId}，使提醒能引用原消息）
- \`--at\`: 一次性定时任务的触发时间
  - 相对时间格式：数字+单位，如 \`5m\`（5分钟）、\`1h\`（1小时）、\`2d\`（2天）【注意：不要加 + 号】
  - 绝对时间格式：ISO 8601 带时区，如 \`2026-02-01T14:00:00+08:00\`
- \`--cron\`: 周期性任务（如 \`0 8 * * *\` 每天早上8点）
- \`--tz "Asia/Shanghai"\`: 周期任务务必设置时区
- \`--delete-after-run\`: 一次性任务必须添加此参数
- \`--message\`: 消息内容（必填，不能为空！对应 QQ API 的 markdown.content 字段）

⚠️ 重要注意事项：
1. --at 参数格式：相对时间用 \`5m\`、\`1h\` 等（不要加 + 号！）；绝对时间用完整 ISO 格式
2. 定时提醒消息不支持流式发送，命令中不要添加 --stream 参数
3. --message 参数必须有实际内容，不能为空字符串`;

        // 只有配置了图床公网地址，才告诉 AI 可以发送图片
        if (imageServerBaseUrl) {
          builtinPrompt += `

【发送图片】
你可以发送本地图片文件给用户。只需在回复中直接引用图片的绝对路径即可，系统会自动处理。
支持 png、jpg、gif、webp 格式。`;
        }
        
        const systemPrompts = [builtinPrompt];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }
        
        // 处理附件（图片等）- 下载到本地供 clawdbot 访问
        let attachmentInfo = "";
        const imageUrls: string[] = [];
        // 存到 clawdbot 工作目录下的 downloads 文件夹
        const downloadDir = path.join(process.env.HOME || "/home/ubuntu", "clawd", "downloads");
        
        if (event.attachments?.length) {
          for (const att of event.attachments) {
            // 下载附件到本地，使用原始文件名
            const localPath = await downloadFile(att.url, downloadDir, att.filename);
            if (localPath) {
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(localPath);
                attachmentInfo += `\n[图片: ${localPath}]`;
              } else {
                attachmentInfo += `\n[附件: ${localPath}]`;
              }
              log?.info(`[qqbot:${account.accountId}] Downloaded attachment to: ${localPath}`);
            } else {
              // 下载失败，提供原始 URL 作为后备
              log?.error(`[qqbot:${account.accountId}] Failed to download attachment: ${att.url}`);
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(att.url);
                attachmentInfo += `\n[图片: ${att.url}] (下载失败，可能无法访问)`;
              } else {
                attachmentInfo += `\n[附件: ${att.filename ?? att.content_type}] (下载失败)`;
              }
            }
          }
        }
        
        const userContent = event.content + attachmentInfo;
        const messageBody = `【系统提示】\n${systemPrompts.join("\n")}\n\n【用户输入】\n${userContent}`;

        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "QQBot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: messageBody,
          chatType: isGroup ? "group" : "direct",
          sender: {
            id: event.senderId,
            name: event.senderName,
          },
          envelope: envelopeOptions,
          // 传递图片 URL 列表
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        });

        const fromAddress = event.type === "guild" ? `qqbot:channel:${event.channelId}`
                         : event.type === "group" ? `qqbot:group:${event.groupOpenid}`
                         : `qqbot:c2c:${event.senderId}`;
        const toAddress = fromAddress;

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: event.content,
          CommandBody: event.content,
          From: fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: isGroup ? "group" : "direct",
          SenderId: event.senderId,
          SenderName: event.senderName,
          Provider: "qqbot",
          Surface: "qqbot",
          MessageSid: event.messageId,
          Timestamp: new Date(event.timestamp).getTime(),
          OriginatingChannel: "qqbot",
          OriginatingTo: toAddress,
          QQChannelId: event.channelId,
          QQGuildId: event.guildId,
          QQGroupOpenid: event.groupOpenid,
        });

        // 发送消息的辅助函数，带 token 过期重试
        const sendWithTokenRetry = async (sendFn: (token: string) => Promise<unknown>) => {
          try {
            const token = await getAccessToken(account.appId, account.clientSecret);
            await sendFn(token);
          } catch (err) {
            const errMsg = String(err);
            // 如果是 token 相关错误，清除缓存重试一次
            if (errMsg.includes("401") || errMsg.includes("token") || errMsg.includes("access_token")) {
              log?.info(`[qqbot:${account.accountId}] Token may be expired, refreshing...`);
              clearTokenCache();
              const newToken = await getAccessToken(account.appId, account.clientSecret);
              await sendFn(newToken);
            } else {
              throw err;
            }
          }
        };

        // 发送错误提示的辅助函数
        const sendErrorMessage = async (errorText: string) => {
          try {
            await sendWithTokenRetry(async (token) => {
              if (event.type === "c2c") {
                await sendC2CMessage(token, event.senderId, errorText, event.messageId);
              } else if (event.type === "group" && event.groupOpenid) {
                await sendGroupMessage(token, event.groupOpenid, errorText, event.messageId);
              } else if (event.channelId) {
                await sendChannelMessage(token, event.channelId, errorText, event.messageId);
              }
            });
          } catch (sendErr) {
            log?.error(`[qqbot:${account.accountId}] Failed to send error message: ${sendErr}`);
          }
        };

        try {
          const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);

          // 追踪是否有响应
          let hasResponse = false;
          const responseTimeout = 60000; // 60秒超时（1分钟）
          let timeoutId: ReturnType<typeof setTimeout> | null = null;

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!hasResponse) {
                reject(new Error("Response timeout"));
              }
            }, responseTimeout);
          });

          // ============ 流式消息发送器 ============
          // 确定发送目标
          const targetTo = event.type === "c2c" ? event.senderId
                        : event.type === "group" ? `group:${event.groupOpenid}`
                        : `channel:${event.channelId}`;
          
          // 判断是否支持流式（仅 c2c 支持，群聊不支持流式，且需要开关启用）
          const supportsStream = event.type === "c2c" && streamEnabled;
          log?.info(`[qqbot:${account.accountId}] Stream support: ${supportsStream} (type=${event.type}, enabled=${streamEnabled})`);
          
          // 创建流式发送器
          const streamSender = supportsStream ? createStreamSender(account, targetTo, event.messageId) : null;
          let streamBuffer = ""; // 累积的全部文本（用于记录完整内容）
          let lastSentLength = 0; // 上次发送时的文本长度（用于计算增量）
          let lastSentText = ""; // 上次发送时的完整文本（用于检测新段落）
          let currentSegmentStart = 0; // 当前段落在 streamBuffer 中的起始位置
          let lastStreamSendTime = 0; // 上次流式发送时间
          let streamStarted = false; // 是否已开始流式发送
          let streamEnded = false; // 流式是否已结束
          let streamStartTime = 0; // 流式消息开始时间（用于超时检查）
          let sendingLock = false; // 发送锁，防止并发发送
          let pendingFullText = ""; // 待发送的完整文本（在锁定期间积累）
          let keepaliveTimer: ReturnType<typeof setTimeout> | null = null; // 心跳定时器
          let keepaliveCountSinceLastChunk = 0; // 自上次分片以来发送的状态保持消息数量
          let lastChunkSendTime = 0; // 上次分片发送时间（用于判断是否需要发送状态保持）
          
          // 清理心跳定时器
          const clearKeepalive = () => {
            if (keepaliveTimer) {
              clearTimeout(keepaliveTimer);
              keepaliveTimer = null;
            }
          };
          
          // 重置心跳定时器（每次发送后调用）
          // isContentChunk: 是否为内容分片（非状态保持消息）
          const resetKeepalive = (isContentChunk: boolean = false) => {
            clearKeepalive();
            
            // 如果是内容分片，重置状态保持计数器和时间
            if (isContentChunk) {
              keepaliveCountSinceLastChunk = 0;
              lastChunkSendTime = Date.now();
            }
            
            if (streamSender && streamStarted && !streamEnded) {
              // 计算下次状态保持消息的延迟时间
              // - 首次：3s（STREAM_KEEPALIVE_FIRST_DELAY）
              // - 后续：10s（STREAM_KEEPALIVE_GAP）
              const delay = keepaliveCountSinceLastChunk === 0 
                ? STREAM_KEEPALIVE_FIRST_DELAY 
                : STREAM_KEEPALIVE_GAP;
              
              keepaliveTimer = setTimeout(async () => {
                // 检查流式消息是否超时（超过 3 分钟自动结束）
                const elapsed = Date.now() - streamStartTime;
                if (elapsed >= STREAM_MAX_DURATION) {
                  log?.info(`[qqbot:${account.accountId}] Stream timeout after ${Math.round(elapsed / 1000)}s, auto ending stream`);
                  if (!streamEnded && !sendingLock) {
                    sendingLock = true;
                    try {
                      // 发送结束标记
                      await streamSender!.send("", true);
                      streamEnded = true;
                      clearKeepalive();
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Stream auto-end failed: ${err}`);
                    } finally {
                      sendingLock = false;
                    }
                  }
                  return; // 超时后不再继续心跳
                }
                
                // 检查是否已达到每2个分片之间的最大状态保持消息数量
                if (keepaliveCountSinceLastChunk >= STREAM_KEEPALIVE_MAX_PER_CHUNK) {
                  log?.debug?.(`[qqbot:${account.accountId}] Max keepalive reached (${keepaliveCountSinceLastChunk}/${STREAM_KEEPALIVE_MAX_PER_CHUNK}), waiting for next content chunk`);
                  // 不再发送状态保持，但继续监控超时
                  resetKeepalive(false);
                  return;
                }
                
                // 检查距上次分片是否超过 3s
                const timeSinceLastChunk = Date.now() - lastChunkSendTime;
                if (timeSinceLastChunk < STREAM_KEEPALIVE_FIRST_DELAY) {
                  // 还未到发送状态保持的时机，继续等待
                  resetKeepalive(false);
                  return;
                }
                
                // 发送状态保持消息
                if (!streamEnded && !sendingLock) {
                  log?.info(`[qqbot:${account.accountId}] Sending keepalive #${keepaliveCountSinceLastChunk + 1} (elapsed: ${Math.round(elapsed / 1000)}s, since chunk: ${Math.round(timeSinceLastChunk / 1000)}s)`);
                  sendingLock = true;
                  try {
                    // 发送空内容
                    await streamSender!.send("", false);
                    lastStreamSendTime = Date.now();
                    keepaliveCountSinceLastChunk++;
                    resetKeepalive(false); // 继续下一个状态保持（非内容分片）
                  } catch (err) {
                    log?.error(`[qqbot:${account.accountId}] Keepalive failed: ${err}`);
                  } finally {
                    sendingLock = false;
                  }
                }
              }, delay);
            }
          };
          
          // 流式发送函数 - 用于 onPartialReply 实时发送（增量模式）
          // markdown 分片需要以 \n 结尾
          const sendStreamChunk = async (text: string, isEnd: boolean): Promise<boolean> => {
            if (!streamSender || streamEnded) return false;
            
            // markdown 分片需要以 \n 结尾（除非是空内容或结束标记）
            let contentToSend = text;
            if (isEnd && contentToSend && !contentToSend.endsWith("\n") && !isEnd) {
              contentToSend = contentToSend + "\n";
            }
            
            const result = await streamSender.send(contentToSend, isEnd);
            if (result.error) {
              log?.error(`[qqbot:${account.accountId}] Stream send error: ${result.error}`);
              return false;
            } else {
              log?.debug?.(`[qqbot:${account.accountId}] Stream chunk sent, index: ${streamSender.getContext().index - 1}, isEnd: ${isEnd}, text: "${text.slice(0, 50)}..."`);
            }
            
            if (isEnd) {
              streamEnded = true;
              clearKeepalive();
            } else {
              // 发送成功后重置心跳，如果是有内容的分片则重置计数器
              const isContentChunk = text.length > 0;
              resetKeepalive(isContentChunk);
            }
            return true;
          };
          
          // 执行一次流式发送（带锁保护）
          const doStreamSend = async (fullText: string, forceEnd: boolean = false): Promise<void> => {
            // 如果正在发送，记录待发送的完整文本，稍后处理
            if (sendingLock) {
              pendingFullText = fullText;
              return;
            }
            
            sendingLock = true;
            try {
              // 发送当前增量
              if (fullText.length > lastSentLength) {
                const increment = fullText.slice(lastSentLength);
                // 首次发送前，先设置流式状态和开始时间
                if (!streamStarted) {
                  streamStarted = true;
                  streamStartTime = Date.now();
                  log?.info(`[qqbot:${account.accountId}] Stream started, max duration: ${STREAM_MAX_DURATION / 1000}s`);
                }
                const success = await sendStreamChunk(increment, forceEnd);
                if (success) {
                  lastSentLength = fullText.length;
                  lastSentText = fullText; // 记录完整发送文本，用于检测新段落
                  lastStreamSendTime = Date.now();
                  log?.info(`[qqbot:${account.accountId}] Stream partial #${streamSender!.getContext().index}, increment: ${increment.length} chars, total: ${fullText.length} chars`);
                }
              } else if (forceEnd && !streamEnded) {
                // 没有新内容但需要结束
                await sendStreamChunk("", true);
              }
            } finally {
              sendingLock = false;
            }
            
            // 处理在锁定期间积累的内容
            if (pendingFullText && pendingFullText.length > lastSentLength && !streamEnded) {
              const pending = pendingFullText;
              pendingFullText = "";
              // 递归发送积累的内容（不强制结束）
              await doStreamSend(pending, false);
            }
          };
          
          // onPartialReply 回调 - 实时接收 AI 生成的文本（payload.text 是累积的全文）
          // 注意：agent 在一次对话中可能产生多个回复段落（如思考、工具调用后继续回复）
          // 每个新段落的 text 会从头开始累积，需要检测并处理
          const handlePartialReply = async (payload: { text?: string }) => {
            if (!streamSender || streamEnded) {
              log?.debug?.(`[qqbot:${account.accountId}] handlePartialReply skipped: streamSender=${!!streamSender}, streamEnded=${streamEnded}`);
              return;
            }
            
            const fullText = payload.text ?? "";
            if (!fullText) {
              log?.debug?.(`[qqbot:${account.accountId}] handlePartialReply: empty text`);
              return;
            }
            
            hasResponse = true;
            
            // 检测是否是新段落：
            // 1. lastSentText 不为空（说明已经发送过内容）
            // 2. 当前文本不是以 lastSentText 开头（说明不是同一段落的增量）
            // 3. 当前文本长度小于 lastSentLength（说明文本被重置了）
            const isNewSegment = lastSentText.length > 0 && 
              (fullText.length < lastSentLength || !fullText.startsWith(lastSentText.slice(0, Math.min(10, lastSentText.length))));
            
            if (isNewSegment) {
              // 新段落开始，将之前的内容追加到 streamBuffer，并重置发送位置
              log?.info(`[qqbot:${account.accountId}] New segment detected! lastSentLength=${lastSentLength}, newTextLength=${fullText.length}, lastSentText="${lastSentText.slice(0, 20)}...", newText="${fullText.slice(0, 20)}..."`);
              
              // 记录当前段落在 streamBuffer 中的起始位置
              currentSegmentStart = streamBuffer.length;
              
              // 追加换行分隔符（如果前面有内容且不以换行结尾）
              if (streamBuffer.length > 0 && !streamBuffer.endsWith("\n")) {
                streamBuffer += "\n\n";
                currentSegmentStart = streamBuffer.length;
              }
              
              // 重置发送位置，从新段落开始发送
              lastSentLength = 0;
              lastSentText = "";
            }
            
            // 更新当前段落内容到 streamBuffer
            // streamBuffer = 之前的段落内容 + 当前段落的完整内容
            const beforeCurrentSegment = streamBuffer.slice(0, currentSegmentStart);
            streamBuffer = beforeCurrentSegment + fullText;
            
            log?.debug?.(`[qqbot:${account.accountId}] handlePartialReply: fullText.length=${fullText.length}, lastSentLength=${lastSentLength}, streamBuffer.length=${streamBuffer.length}, isNewSegment=${isNewSegment}`);
            
            // 如果没有新内容，跳过
            if (fullText.length <= lastSentLength) return;
            
            const now = Date.now();
            // 控制发送频率：首次发送或间隔超过阈值
            if (!streamStarted || now - lastStreamSendTime >= STREAM_CHUNK_INTERVAL) {
              log?.info(`[qqbot:${account.accountId}] handlePartialReply: sending stream chunk, length=${fullText.length}`);
              await doStreamSend(fullText, false);
            } else {
              // 不到发送时间，但记录待发送内容，确保最终会被发送
              pendingFullText = fullText;
            }
          };

          const dispatchPromise = pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,
              deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }, info: { kind: string }) => {
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }

                log?.info(`[qqbot:${account.accountId}] deliver called, kind: ${info.kind}, payload keys: ${Object.keys(payload).join(", ")}`);

                let replyText = payload.text ?? "";
                
                // 更新当前段落内容到 streamBuffer
                // deliver 中的 replyText 是当前段落的完整文本
                if (replyText.length > 0) {
                  const beforeCurrentSegment = streamBuffer.slice(0, currentSegmentStart);
                  const newStreamBuffer = beforeCurrentSegment + replyText;
                  if (newStreamBuffer.length > streamBuffer.length) {
                    streamBuffer = newStreamBuffer;
                    log?.debug?.(`[qqbot:${account.accountId}] deliver: updated streamBuffer, replyText=${replyText.length}, total=${streamBuffer.length}`);
                  }
                }
                
                // 收集所有图片路径
                const imageUrls: string[] = [];
                
                // 处理 mediaUrls 和 mediaUrl 字段（本地文件路径）
                const mediaPaths: string[] = [];
                if (payload.mediaUrls?.length) {
                  mediaPaths.push(...payload.mediaUrls);
                }
                if (payload.mediaUrl && !mediaPaths.includes(payload.mediaUrl)) {
                  mediaPaths.push(payload.mediaUrl);
                }
                
                for (const localPath of mediaPaths) {
                  if (localPath && imageServerBaseUrl) {
                    try {
                      const savedUrl = saveImageFromPath(localPath);
                      if (savedUrl) {
                        imageUrls.push(savedUrl);
                        log?.info(`[qqbot:${account.accountId}] Saved media to server: ${localPath}`);
                      } else {
                        log?.error(`[qqbot:${account.accountId}] Failed to save media (not found or not image): ${localPath}`);
                      }
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Failed to save media: ${err}`);
                    }
                  }
                }
                
                // 提取文本中的各种图片格式
                // 0. 提取 MEDIA: 前缀的本地文件路径
                const mediaPathRegex = /MEDIA:([^\s\n]+)/gi;
                const mediaMatches = [...replyText.matchAll(mediaPathRegex)];
                for (const match of mediaMatches) {
                  const localPath = match[1];
                  if (localPath && imageServerBaseUrl) {
                    try {
                      const savedUrl = saveImageFromPath(localPath);
                      if (savedUrl) {
                        imageUrls.push(savedUrl);
                        log?.info(`[qqbot:${account.accountId}] Saved local image to server: ${localPath}`);
                      }
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Failed to save local image: ${err}`);
                    }
                  }
                  replyText = replyText.replace(match[0], "").trim();
                }
                
                // 0.5. 提取本地绝对文件路径
                const localPathRegex = /(\/[^\s\n]+?(?:\.(?:png|jpg|jpeg|gif|webp)|_(?:png|jpg|jpeg|gif|webp)(?:\s|$)))/gi;
                const localPathMatches = [...replyText.matchAll(localPathRegex)];
                for (const match of localPathMatches) {
                  let localPath = match[1].trim();
                  if (localPath && imageServerBaseUrl) {
                    localPath = localPath.replace(/_(?=(?:png|jpg|jpeg|gif|webp)$)/, ".");
                    try {
                      const savedUrl = saveImageFromPath(localPath);
                      if (savedUrl) {
                        imageUrls.push(savedUrl);
                        log?.info(`[qqbot:${account.accountId}] Saved local path image to server: ${localPath}`);
                      }
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Failed to save local path image: ${err}`);
                    }
                  }
                  replyText = replyText.replace(match[0], "").trim();
                }
                
                // 1. 提取 base64 图片
                const base64ImageRegex = /!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)|(?<![(\[])(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/gi;
                const base64Matches = [...replyText.matchAll(base64ImageRegex)];
                for (const match of base64Matches) {
                  const dataUrl = match[2] || match[3];
                  if (dataUrl && imageServerBaseUrl) {
                    try {
                      const savedUrl = saveImage(dataUrl);
                      imageUrls.push(savedUrl);
                      log?.info(`[qqbot:${account.accountId}] Saved base64 image to local server`);
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Failed to save base64 image: ${err}`);
                    }
                  }
                  replyText = replyText.replace(match[0], "").trim();
                }

                // 2. 提取 URL 图片
                const imageUrlRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s)]*)?)\)|(?<![(\[])(https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s]*)?)/gi;
                const urlMatches = [...replyText.matchAll(imageUrlRegex)];
                for (const match of urlMatches) {
                  const url = match[2] || match[3];
                  if (url) {
                    imageUrls.push(url);
                  }
                }
                
                // 从文本中移除图片 URL
                let textWithoutImages = replyText;
                for (const match of urlMatches) {
                  textWithoutImages = textWithoutImages.replace(match[0], "").trim();
                }

                // 处理剩余文本中的 URL 点号（只有在没有图片的情况下才替换）
                const hasImages = imageUrls.length > 0;
                if (!hasImages && textWithoutImages) {
                  const originalText = textWithoutImages;
                  textWithoutImages = textWithoutImages.replace(/([a-zA-Z0-9])\.([a-zA-Z0-9])/g, "$1_$2");
                  if (textWithoutImages !== originalText && textWithoutImages.trim()) {
                    textWithoutImages += "\n\n（由于平台限制，回复中的部分符号已被替换）";
                  }
                }

                try {
                  // 发送图片（如果有）
                  for (const imageUrl of imageUrls) {
                    try {
                      await sendWithTokenRetry(async (token) => {
                        if (event.type === "c2c") {
                          await sendC2CImageMessage(token, event.senderId, imageUrl, event.messageId);
                        } else if (event.type === "group" && event.groupOpenid) {
                          await sendGroupImageMessage(token, event.groupOpenid, imageUrl, event.messageId);
                        }
                      });
                      log?.info(`[qqbot:${account.accountId}] Sent image: ${imageUrl.slice(0, 50)}...`);
                    } catch (imgErr) {
                      log?.error(`[qqbot:${account.accountId}] Failed to send image: ${imgErr}`);
                    }
                  }

                  // 只有频道和群聊消息（不支持流式）在 deliver 中发送文本
                  // c2c 的文本通过 onPartialReply 流式发送
                  if (!supportsStream && textWithoutImages.trim()) {
                    await sendWithTokenRetry(async (token) => {
                      if (event.type === "group" && event.groupOpenid) {
                        await sendGroupMessage(token, event.groupOpenid, textWithoutImages, event.messageId);
                      } else if (event.channelId) {
                        await sendChannelMessage(token, event.channelId, textWithoutImages, event.messageId);
                      }
                    });
                    log?.info(`[qqbot:${account.accountId}] Sent text reply (${event.type}, non-stream)`);
                  }

                  pluginRuntime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                } catch (err) {
                  log?.error(`[qqbot:${account.accountId}] Send failed: ${err}`);
                }
              },
              onError: async (err: unknown) => {
                log?.error(`[qqbot:${account.accountId}] Dispatch error: ${err}`);
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
                
                // 清理心跳定时器
                clearKeepalive();
                
                // 如果在流式模式中出错，发送结束标记（增量模式）
                if (streamSender && !streamEnded && streamBuffer) {
                  try {
                    // 等待发送锁释放
                    while (sendingLock) {
                      await new Promise(resolve => setTimeout(resolve, 50));
                    }
                    // 发送剩余增量 + 错误标记
                    const remainingIncrement = streamBuffer.slice(lastSentLength);
                    const errorIncrement = remainingIncrement + "\n\n[生成中断]";
                    await streamSender.end(errorIncrement);
                    streamEnded = true;
                    log?.info(`[qqbot:${account.accountId}] Stream ended due to error`);
                  } catch (endErr) {
                    log?.error(`[qqbot:${account.accountId}] Failed to end stream: ${endErr}`);
                  }
                }
                
                // 发送错误提示给用户，显示完整错误信息
                const errMsg = String(err);
                if (errMsg.includes("401") || errMsg.includes("key") || errMsg.includes("auth")) {
                  await sendErrorMessage("[ClawdBot] 大模型 API Key 可能无效，请检查配置");
                } else {
                  // 显示完整错误信息，截取前 500 字符
                  await sendErrorMessage(`[ClawdBot] 出错: ${errMsg.slice(0, 500)}`);
                }
              },
            },
            replyOptions: {
              // 使用 onPartialReply 实现真正的流式消息
              // 这个回调在 AI 生成过程中被实时调用
              onPartialReply: supportsStream ? handlePartialReply : undefined,
              // 禁用 block streaming，因为我们用 onPartialReply 实现更实时的流式
              disableBlockStreaming: supportsStream,
            },
          });

          // 等待分发完成或超时
          try {
            await Promise.race([dispatchPromise, timeoutPromise]);
            
            // 清理心跳定时器
            clearKeepalive();
            
            // 分发完成后，如果使用了流式且有内容，发送结束标记
            if (streamSender && !streamEnded) {
              // 等待发送锁释放
              while (sendingLock) {
                await new Promise(resolve => setTimeout(resolve, 50));
              }
              
              // 确保所有待发送内容都发送出去
              // 当前段落的最新完整文本
              const currentSegmentText = pendingFullText && pendingFullText.length > (streamBuffer.length - currentSegmentStart)
                ? pendingFullText 
                : streamBuffer.slice(currentSegmentStart);
              
              // 计算当前段落剩余未发送的增量内容
              const remainingIncrement = currentSegmentText.slice(lastSentLength);
              if (remainingIncrement || streamStarted) {
                // 有剩余内容或者已开始流式，都需要发送结束标记
                await streamSender.end(remainingIncrement);
                streamEnded = true;
                log?.info(`[qqbot:${account.accountId}] Stream completed, final increment: ${remainingIncrement.length} chars, total streamBuffer: ${streamBuffer.length} chars, chunks: ${streamSender.getContext().index}`);
              }
            }
          } catch (err) {
            // 清理心跳定时器
            clearKeepalive();
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            if (!hasResponse) {
              log?.error(`[qqbot:${account.accountId}] No response within timeout`);
              await sendErrorMessage("[ClawdBot] QQ响应正常，但未收到clawdbot响应，请检查大模型是否正确配置");
            }
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processing failed: ${err}`);
          await sendErrorMessage(`[ClawdBot] 处理失败: ${String(err).slice(0, 500)}`);
        }
      };

      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false; // 连接完成，释放锁
        reconnectAttempts = 0; // 连接成功，重置重试计数
        lastConnectTime = Date.now(); // 记录连接时间
        // 启动消息处理器（异步处理，防止阻塞心跳）
        startMessageProcessor(handleMessage);
        // P1-1: 启动后台 Token 刷新
        startBackgroundTokenRefresh(account.appId, account.clientSecret, {
          log: log as { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void },
        });
      });

      ws.on("message", async (data) => {
        try {
          const rawData = data.toString();
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) {
            lastSeq = s;
            // P1-2: 更新持久化存储中的 lastSeq（节流保存）
            if (sessionId) {
              saveSession({
                sessionId,
                lastSeq,
                lastConnectedAt: lastConnectTime,
                intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex,
                accountId: account.accountId,
                savedAt: Date.now(),
              });
            }
          }

          log?.debug?.(`[qqbot:${account.accountId}] Received op=${op} t=${t}`);

          switch (op) {
            case 10: // Hello
              log?.info(`[qqbot:${account.accountId}] Hello received`);
              
              // 如果有 session_id，尝试 Resume
              if (sessionId && lastSeq !== null) {
                log?.info(`[qqbot:${account.accountId}] Attempting to resume session ${sessionId}`);
                ws.send(JSON.stringify({
                  op: 6, // Resume
                  d: {
                    token: `QQBot ${accessToken}`,
                    session_id: sessionId,
                    seq: lastSeq,
                  },
                }));
              } else {
                // 新连接，发送 Identify
                // 如果有上次成功的级别，直接使用；否则从当前级别开始尝试
                const levelToUse = lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex;
                const intentLevel = INTENT_LEVELS[Math.min(levelToUse, INTENT_LEVELS.length - 1)];
                log?.info(`[qqbot:${account.accountId}] Sending identify with intents: ${intentLevel.intents} (${intentLevel.description})`);
                ws.send(JSON.stringify({
                  op: 2,
                  d: {
                    token: `QQBot ${accessToken}`,
                    intents: intentLevel.intents,
                    shard: [0, 1],
                  },
                }));
              }

              // 启动心跳
              const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                  log?.debug?.(`[qqbot:${account.accountId}] Heartbeat sent`);
                }
              }, interval);
              break;

            case 0: // Dispatch
              if (t === "READY") {
                const readyData = d as { session_id: string };
                sessionId = readyData.session_id;
                // 记录成功的权限级别
                lastSuccessfulIntentLevel = intentLevelIndex;
                const successLevel = INTENT_LEVELS[intentLevelIndex];
                log?.info(`[qqbot:${account.accountId}] Ready with ${successLevel.description}, session: ${sessionId}`);
                // P1-2: 保存新的 Session 状态
                saveSession({
                  sessionId,
                  lastSeq,
                  lastConnectedAt: Date.now(),
                  intentLevelIndex,
                  accountId: account.accountId,
                  savedAt: Date.now(),
                });
                onReady?.(d);
              } else if (t === "RESUMED") {
                log?.info(`[qqbot:${account.accountId}] Session resumed`);
                // P1-2: 更新 Session 连接时间
                if (sessionId) {
                  saveSession({
                    sessionId,
                    lastSeq,
                    lastConnectedAt: Date.now(),
                    intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex,
                    accountId: account.accountId,
                    savedAt: Date.now(),
                  });
                }
              } else if (t === "C2C_MESSAGE_CREATE") {
                const event = d as C2CMessageEvent;
                // P1-3: 记录已知用户
                recordKnownUser({
                  openid: event.author.user_openid,
                  type: "c2c",
                  accountId: account.accountId,
                });
                // 使用消息队列异步处理，防止阻塞心跳
                enqueueMessage({
                  type: "c2c",
                  senderId: event.author.user_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  attachments: event.attachments,
                });
              } else if (t === "AT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // P1-3: 记录已知用户（频道用户）
                recordKnownUser({
                  openid: event.author.id,
                  type: "c2c", // 频道用户按 c2c 类型存储
                  nickname: event.author.username,
                  accountId: account.accountId,
                });
                enqueueMessage({
                  type: "guild",
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  channelId: event.channel_id,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                });
              } else if (t === "DIRECT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // P1-3: 记录已知用户（频道私信用户）
                recordKnownUser({
                  openid: event.author.id,
                  type: "c2c",
                  nickname: event.author.username,
                  accountId: account.accountId,
                });
                enqueueMessage({
                  type: "dm",
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                });
              } else if (t === "GROUP_AT_MESSAGE_CREATE") {
                const event = d as GroupMessageEvent;
                // P1-3: 记录已知用户（群组用户）
                recordKnownUser({
                  openid: event.author.member_openid,
                  type: "group",
                  groupOpenid: event.group_openid,
                  accountId: account.accountId,
                });
                enqueueMessage({
                  type: "group",
                  senderId: event.author.member_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  groupOpenid: event.group_openid,
                  attachments: event.attachments,
                });
              }
              break;

            case 11: // Heartbeat ACK
              log?.debug?.(`[qqbot:${account.accountId}] Heartbeat ACK`);
              break;

            case 7: // Reconnect
              log?.info(`[qqbot:${account.accountId}] Server requested reconnect`);
              cleanup();
              scheduleReconnect();
              break;

            case 9: // Invalid Session
              const canResume = d as boolean;
              const currentLevel = INTENT_LEVELS[intentLevelIndex];
              log?.error(`[qqbot:${account.accountId}] Invalid session (${currentLevel.description}), can resume: ${canResume}, raw: ${rawData}`);
              
              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                // P1-2: 清除持久化的 Session
                clearSession(account.accountId);
                
                // 尝试降级到下一个权限级别
                if (intentLevelIndex < INTENT_LEVELS.length - 1) {
                  intentLevelIndex++;
                  const nextLevel = INTENT_LEVELS[intentLevelIndex];
                  log?.info(`[qqbot:${account.accountId}] Downgrading intents to: ${nextLevel.description}`);
                } else {
                  // 已经是最低权限级别了
                  log?.error(`[qqbot:${account.accountId}] All intent levels failed. Please check AppID/Secret.`);
                  shouldRefreshToken = true;
                }
              }
              cleanup();
              // Invalid Session 后等待一段时间再重连
              scheduleReconnect(3000);
              break;
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message parse error: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false; // 释放锁
        
        // 根据错误码处理
        // 4009: 可以重新发起 resume
        // 4900-4913: 内部错误，需要重新 identify
        // 4914: 机器人已下架
        // 4915: 机器人已封禁
        if (code === 4914 || code === 4915) {
          log?.error(`[qqbot:${account.accountId}] Bot is ${code === 4914 ? "offline/sandbox-only" : "banned"}. Please contact QQ platform.`);
          cleanup();
          // 不重连，直接退出
          return;
        }
        
        if (code === 4009) {
          // 4009 可以尝试 resume，保留 session
          log?.info(`[qqbot:${account.accountId}] Error 4009, will try resume`);
          shouldRefreshToken = true;
        } else if (code >= 4900 && code <= 4913) {
          // 4900-4913 内部错误，清除 session 重新 identify
          log?.info(`[qqbot:${account.accountId}] Internal error (${code}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          shouldRefreshToken = true;
        }
        
        // 检测是否是快速断开（连接后很快就断了）
        const connectionDuration = Date.now() - lastConnectTime;
        if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          log?.info(`[qqbot:${account.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${quickDisconnectCount}`);
          
          // 如果连续快速断开超过阈值，等待更长时间
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            log?.error(`[qqbot:${account.accountId}] Too many quick disconnects. This may indicate a permission issue.`);
            log?.error(`[qqbot:${account.accountId}] Please check: 1) AppID/Secret correct 2) Bot permissions on QQ Open Platform`);
            quickDisconnectCount = 0;
            cleanup();
            // 快速断开太多次，等待更长时间再重连
            if (!isAborted && code !== 1000) {
              scheduleReconnect(RATE_LIMIT_DELAY);
            }
            return;
          }
        } else {
          // 连接持续时间够长，重置计数
          quickDisconnectCount = 0;
        }
        
        cleanup();
        
        // 非正常关闭则重连
        if (!isAborted && code !== 1000) {
          scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err.message}`);
        onError?.(err);
      });

    } catch (err) {
      isConnecting = false; // 释放锁
      const errMsg = String(err);
      log?.error(`[qqbot:${account.accountId}] Connection failed: ${err}`);
      
      // 如果是频率限制错误，等待更长时间
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        log?.info(`[qqbot:${account.accountId}] Rate limited, waiting ${RATE_LIMIT_DELAY}ms before retry`);
        scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        scheduleReconnect();
      }
    }
  };

  // 开始连接
  await connect();

  // 等待 abort 信号
  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
