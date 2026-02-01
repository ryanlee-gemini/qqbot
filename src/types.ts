/**
 * QQ Bot 配置类型
 */
export interface QQBotConfig {
  appId: string;
  clientSecret?: string;
  clientSecretFile?: string;
}

/**
 * 解析后的 QQ Bot 账户
 */
export interface ResolvedQQBotAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  clientSecret: string;
  secretSource: "config" | "file" | "env" | "none";
  /** 系统提示词 */
  systemPrompt?: string;
  /** 图床服务器公网地址 */
  imageServerBaseUrl?: string;
  /** 是否支持 markdown 消息 */
  markdownSupport?: boolean;
  /** 是否启用流式消息（仅 c2c 私聊支持），默认 true */
  streamEnabled?: boolean;
  config: QQBotAccountConfig;
}

/**
 * QQ Bot 账户配置
 */
export interface QQBotAccountConfig {
  enabled?: boolean;
  name?: string;
  appId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  dmPolicy?: "open" | "pairing" | "allowlist";
  allowFrom?: string[];
  /** 系统提示词，会添加在用户消息前面 */
  systemPrompt?: string;
  /** 图床服务器公网地址，用于发送图片，例如 http://your-ip:18765 */
  imageServerBaseUrl?: string;
  /** 是否支持 markdown 消息，默认 true */
  markdownSupport?: boolean;
  /** 是否启用流式消息，默认 true（仅 c2c 私聊支持） */
  streamEnabled?: boolean;
}

/**
 * 富媒体附件
 */
export interface MessageAttachment {
  content_type: string;  // 如 "image/png"
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
  url: string;
}

/**
 * C2C 消息事件
 */
export interface C2CMessageEvent {
  author: {
    id: string;
    union_openid: string;
    user_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  message_scene?: {
    source: string;
  };
  attachments?: MessageAttachment[];
}

/**
 * 频道 AT 消息事件
 */
export interface GuildMessageEvent {
  id: string;
  channel_id: string;
  guild_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username?: string;
    bot?: boolean;
  };
  member?: {
    nick?: string;
    joined_at?: string;
  };
  attachments?: MessageAttachment[];
}

/**
 * 群聊 AT 消息事件
 */
export interface GroupMessageEvent {
  author: {
    id: string;
    member_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  group_id: string;
  group_openid: string;
  attachments?: MessageAttachment[];
}

/**
 * WebSocket 事件负载
 */
export interface WSPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

/**
 * 流式消息状态
 */
export enum StreamState {
  /** 流式消息开始/进行中 */
  STREAMING = 1,
  /** 流式消息结束 */
  END = 10,
}

/**
 * 流式消息配置
 */
export interface StreamConfig {
  /** 流式状态: 1=开始/进行中, 10=结束 */
  state: StreamState;
  /** 分片索引，从0开始 */
  index: number;
  /** 流式消息ID，第一次发送为空，后续需要带上服务端返回的ID */
  id: string;
}

/**
 * 流式消息发送上下文
 */
export interface StreamContext {
  /** 当前分片索引 */
  index: number;
  /** 流式消息ID（首次发送后由服务端返回） */
  streamId: string;
  /** 是否已结束 */
  ended: boolean;
}
