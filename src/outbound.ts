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
 * - 有 replyToId: 被动回复，无配额限制
 * - 无 replyToId: 主动发送，有配额限制（每月4条/用户/群）
 */
export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account } = ctx;

  console.log("[qqbot] sendText ctx:", JSON.stringify({ to, text: text?.slice(0, 50), replyToId, accountId: account.accountId }, null, 2));

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
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } else if (target.type === "group") {
      const result = await sendGroupMessage(accessToken, target.id, text, replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } else {
      const result = await sendChannelMessage(accessToken, target.id, text, replyToId);
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
