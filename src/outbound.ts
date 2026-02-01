/**
 * QQ Bot 消息发送模块（支持流式消息）
 */

import type { ResolvedQQBotAccount, StreamContext } from "./types.js";
import { StreamState } from "./types.js";
import { 
  getAccessToken, 
  sendC2CMessage, 
  sendChannelMessage, 
  sendGroupMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendC2CImageMessage,
  sendGroupImageMessage,
  type StreamMessageResponse,
} from "./api.js";

// ============ 消息回复限流器 ============
// 同一 message_id 1小时内最多回复 4 次，超过 1 小时无法被动回复（需改为主动消息）
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1小时

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

/** 限流检查结果 */
export interface ReplyLimitResult {
  /** 是否允许被动回复 */
  allowed: boolean;
  /** 剩余被动回复次数 */
  remaining: number;
  /** 是否需要降级为主动消息（超期或超过次数） */
  shouldFallbackToProactive: boolean;
  /** 降级原因 */
  fallbackReason?: "expired" | "limit_exceeded";
  /** 提示消息 */
  message?: string;
}

/**
 * 检查是否可以回复该消息（限流检查）
 * @param messageId 消息ID
 * @returns ReplyLimitResult 限流检查结果
 */
export function checkMessageReplyLimit(messageId: string): ReplyLimitResult {
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
  
  // 新消息，首次回复
  if (!record) {
    return { 
      allowed: true, 
      remaining: MESSAGE_REPLY_LIMIT,
      shouldFallbackToProactive: false,
    };
  }
  
  // 检查是否超过1小时（message_id 过期）
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    // 超过1小时，被动回复不可用，需要降级为主动消息
    return { 
      allowed: false, 
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "expired",
      message: `消息已超过1小时有效期，将使用主动消息发送`,
    };
  }
  
  // 检查是否超过回复次数限制
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  if (remaining <= 0) {
    return { 
      allowed: false, 
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "limit_exceeded",
      message: `该消息已达到1小时内最大回复次数(${MESSAGE_REPLY_LIMIT}次)，将使用主动消息发送`,
    };
  }
  
  return { 
    allowed: true, 
    remaining,
    shouldFallbackToProactive: false,
  };
}

/**
 * 记录一次消息回复
 * @param messageId 消息ID
 */
export function recordMessageReply(messageId: string): void {
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
  console.log(`[qqbot] recordMessageReply: ${messageId}, count=${messageReplyTracker.get(messageId)?.count}`);
}

/**
 * 获取消息回复统计信息
 */
export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  let totalReplies = 0;
  for (const record of messageReplyTracker.values()) {
    totalReplies += record.count;
  }
  return { trackedMessages: messageReplyTracker.size, totalReplies };
}

/**
 * 获取消息回复限制配置（供外部查询）
 */
export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return {
    limit: MESSAGE_REPLY_LIMIT,
    ttlMs: MESSAGE_REPLY_TTL,
    ttlHours: MESSAGE_REPLY_TTL / (60 * 60 * 1000),
  };
}

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  account: ResolvedQQBotAccount;
}

export interface MediaOutboundContext extends OutboundContext {
  mediaUrl: string;
}

export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
  /** 流式消息ID，用于后续分片 */
  streamId?: string;
}

/**
 * 流式消息发送器
 * 用于管理一个完整的流式消息会话
 */
export class StreamSender {
  private context: StreamContext;
  private accessToken: string | null = null;
  private targetType: "c2c" | "group" | "channel";
  private targetId: string;
  private msgId?: string;
  private account: ResolvedQQBotAccount;

  constructor(
    account: ResolvedQQBotAccount,
    to: string,
    replyToId?: string | null
  ) {
    this.account = account;
    this.msgId = replyToId ?? undefined;
    this.context = {
      index: 0,
      streamId: "",
      ended: false,
    };

    // 解析目标地址
    const target = parseTarget(to);
    this.targetType = target.type;
    this.targetId = target.id;
  }

  /**
   * 发送流式消息分片
   * @param text 分片内容
   * @param isEnd 是否是最后一个分片
   * @returns 发送结果
   */
  async send(text: string, isEnd = false): Promise<OutboundResult> {
    if (this.context.ended) {
      return { channel: "qqbot", error: "Stream already ended" };
    }

    if (!this.account.appId || !this.account.clientSecret) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
    }

    try {
      // 获取或复用 accessToken
      if (!this.accessToken) {
        this.accessToken = await getAccessToken(this.account.appId, this.account.clientSecret);
      }

      const streamConfig = {
        state: isEnd ? StreamState.END : StreamState.STREAMING,
        index: this.context.index,
        id: this.context.streamId,
      };

      let result: StreamMessageResponse;

      if (this.targetType === "c2c") {
        result = await sendC2CMessage(
          this.accessToken,
          this.targetId,
          text,
          this.msgId,
          streamConfig
        );
      } else if (this.targetType === "group") {
        // 群聊不支持流式，直接发送普通消息
        const groupResult = await sendGroupMessage(
          this.accessToken,
          this.targetId,
          text,
          this.msgId
          // 不传 streamConfig
        );
        return { 
          channel: "qqbot", 
          messageId: groupResult.id, 
          timestamp: groupResult.timestamp 
        };
      } else {
        // 频道不支持流式，直接发送普通消息
        const channelResult = await sendChannelMessage(
          this.accessToken,
          this.targetId,
          text,
          this.msgId
        );
        return { 
          channel: "qqbot", 
          messageId: channelResult.id, 
          timestamp: channelResult.timestamp 
        };
      }

      // 更新流式上下文
      // 第一次发送后，服务端会返回 stream_id（或在 id 字段中），后续需要带上
      if (this.context.index === 0 && result.stream_id) {
        this.context.streamId = result.stream_id;
      } else if (this.context.index === 0 && result.id && !this.context.streamId) {
        // 某些情况下 stream_id 可能在 id 字段返回
        this.context.streamId = result.id;
      }

      this.context.index++;

      if (isEnd) {
        this.context.ended = true;
      }

      return { 
        channel: "qqbot", 
        messageId: result.id, 
        timestamp: result.timestamp,
        streamId: this.context.streamId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { channel: "qqbot", error: message };
    }
  }

  /**
   * 结束流式消息
   * @param text 最后一个分片的内容（可选）
   */
  async end(text?: string): Promise<OutboundResult> {
    return this.send(text ?? "", true);
  }

  /**
   * 获取当前流式上下文状态
   */
  getContext(): Readonly<StreamContext> {
    return { ...this.context };
  }

  /**
   * 是否已结束
   */
  isEnded(): boolean {
    return this.context.ended;
  }
}

/**
 * 解析目标地址
 * 格式：
 *   - openid (32位十六进制) -> C2C 单聊
 *   - group:xxx -> 群聊
 *   - channel:xxx -> 频道
 *   - 纯数字 -> 频道
 */
function parseTarget(to: string): { type: "c2c" | "group" | "channel"; id: string } {
  // 去掉 qqbot: 前缀
  let id = to.replace(/^qqbot:/i, "");
  
  if (id.startsWith("c2c:")) {
    return { type: "c2c", id: id.slice(4) };
  }
  if (id.startsWith("group:")) {
    return { type: "group", id: id.slice(6) };
  }
  if (id.startsWith("channel:")) {
    return { type: "channel", id: id.slice(8) };
  }
  // 默认当作 c2c（私聊）
  return { type: "c2c", id };
}

/**
 * 发送文本消息
 * - 有 replyToId: 被动回复，1小时内最多回复4次
 * - 无 replyToId: 主动发送，有配额限制（每月4条/用户/群）
 * 
 * 注意：
 * 1. 主动消息（无 replyToId）必须有消息内容，不支持流式发送
 * 2. 当被动回复不可用（超期或超过次数）时，自动降级为主动消息
 */
export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, text, account } = ctx;
  let { replyToId } = ctx;
  let fallbackToProactive = false;

  console.log("[qqbot] sendText ctx:", JSON.stringify({ to, text: text?.slice(0, 50), replyToId, accountId: account.accountId }, null, 2));

  // ============ 消息回复限流检查 ============
  // 如果有 replyToId，检查是否可以被动回复
  if (replyToId) {
    const limitCheck = checkMessageReplyLimit(replyToId);
    
    if (!limitCheck.allowed) {
      // 检查是否需要降级为主动消息
      if (limitCheck.shouldFallbackToProactive) {
        console.warn(`[qqbot] sendText: 被动回复不可用，降级为主动消息 - ${limitCheck.message}`);
        fallbackToProactive = true;
        replyToId = null; // 清除 replyToId，改为主动消息
      } else {
        // 不应该发生，但作为保底
        console.error(`[qqbot] sendText: 消息回复被限流但未设置降级 - ${limitCheck.message}`);
        return { 
          channel: "qqbot", 
          error: limitCheck.message 
        };
      }
    } else {
      console.log(`[qqbot] sendText: 消息 ${replyToId} 剩余被动回复次数: ${limitCheck.remaining}/${MESSAGE_REPLY_LIMIT}`);
    }
  }

  // ============ 主动消息校验（参考 Telegram 机制） ============
  // 如果是主动消息（无 replyToId 或降级后），必须有消息内容
  if (!replyToId) {
    if (!text || text.trim().length === 0) {
      console.error("[qqbot] sendText error: 主动消息的内容不能为空 (text is empty)");
      return { 
        channel: "qqbot", 
        error: "主动消息必须有内容 (--message 参数不能为空)" 
      };
    }
    if (fallbackToProactive) {
      console.log(`[qqbot] sendText: [降级] 发送主动消息到 ${to}, 内容长度: ${text.length}`);
    } else {
      console.log(`[qqbot] sendText: 发送主动消息到 ${to}, 内容长度: ${text.length}`);
    }
  }

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    console.log("[qqbot] sendText target:", JSON.stringify(target));

    // 如果没有 replyToId，使用主动发送接口
    if (!replyToId) {
      if (target.type === "c2c") {
        const result = await sendProactiveC2CMessage(accessToken, target.id, text);
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      } else if (target.type === "group") {
        const result = await sendProactiveGroupMessage(accessToken, target.id, text);
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      } else {
        // 频道暂不支持主动消息
        const result = await sendChannelMessage(accessToken, target.id, text);
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      }
    }

    // 有 replyToId，使用被动回复接口
    if (target.type === "c2c") {
      const result = await sendC2CMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } else if (target.type === "group") {
      const result = await sendGroupMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } else {
      const result = await sendChannelMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 流式发送文本消息
 * 
 * @param ctx 发送上下文
 * @param textGenerator 异步文本生成器，每次 yield 一个分片
 * @returns 最终发送结果
 * 
 * @example
 * ```typescript
 * async function* generateText() {
 *   yield "Hello, ";
 *   yield "this is ";
 *   yield "a streaming ";
 *   yield "message!";
 * }
 * 
 * const result = await sendTextStream(ctx, generateText());
 * ```
 */
export async function sendTextStream(
  ctx: OutboundContext,
  textGenerator: AsyncIterable<string>
): Promise<OutboundResult> {
  const { to, replyToId, account } = ctx;
  
  const sender = new StreamSender(account, to, replyToId);
  let lastResult: OutboundResult = { channel: "qqbot" };
  let buffer = "";

  try {
    for await (const chunk of textGenerator) {
      buffer += chunk;
      
      // 发送当前分片
      lastResult = await sender.send(buffer, false);
      
      if (lastResult.error) {
        return lastResult;
      }
    }

    // 发送结束标记
    lastResult = await sender.end(buffer);
    
    return lastResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 创建流式消息发送器
 * 提供更细粒度的控制
 */
export function createStreamSender(
  account: ResolvedQQBotAccount,
  to: string,
  replyToId?: string | null
): StreamSender {
  return new StreamSender(account, to, replyToId);
}

/**
 * 主动发送消息（不需要 replyToId，有配额限制：每月 4 条/用户/群）
 * 
 * @param account - 账户配置
 * @param to - 目标地址，格式：openid（单聊）或 group:xxx（群聊）
 * @param text - 消息内容
 */
export async function sendProactiveMessage(
  account: ResolvedQQBotAccount,
  to: string,
  text: string
): Promise<OutboundResult> {
  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    if (target.type === "c2c") {
      const result = await sendProactiveC2CMessage(accessToken, target.id, text);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } else if (target.type === "group") {
      const result = await sendProactiveGroupMessage(accessToken, target.id, text);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } else {
      // 频道暂不支持主动消息，使用普通发送
      const result = await sendChannelMessage(accessToken, target.id, text);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 发送富媒体消息（图片）
 * 
 * @param ctx - 发送上下文，包含 mediaUrl
 * @returns 发送结果
 * 
 * @example
 * ```typescript
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "https://example.com/image.png",
 *   account,
 *   replyToId: msgId,
 * });
 * ```
 */
export async function sendMedia(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, mediaUrl, replyToId, account } = ctx;

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  if (!mediaUrl) {
    return { channel: "qqbot", error: "mediaUrl is required for sendMedia" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    // 先发送图片
    let imageResult: { id: string; timestamp: number | string };
    if (target.type === "c2c") {
      imageResult = await sendC2CImageMessage(
        accessToken,
        target.id,
        mediaUrl,
        replyToId ?? undefined,
        undefined // content 参数，图片消息不支持同时带文本
      );
    } else if (target.type === "group") {
      imageResult = await sendGroupImageMessage(
        accessToken,
        target.id,
        mediaUrl,
        replyToId ?? undefined,
        undefined
      );
    } else {
      // 频道暂不支持富媒体消息，只发送文本 + URL
      const textWithUrl = text ? `${text}\n${mediaUrl}` : mediaUrl;
      const result = await sendChannelMessage(accessToken, target.id, textWithUrl, replyToId ?? undefined);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    }

    // 如果有文本说明，再发送一条文本消息
    if (text?.trim()) {
      try {
        if (target.type === "c2c") {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === "group") {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        // 文本发送失败不影响整体结果，图片已发送成功
        console.error(`[qqbot] Failed to send text after image: ${textErr}`);
      }
    }

    return { channel: "qqbot", messageId: imageResult.id, timestamp: imageResult.timestamp };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}
