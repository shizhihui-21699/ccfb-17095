/**
 * 受信弹窗（第三方登录 / 支付）与原页面之间的 postMessage 协议。
 *
 * 安全要点：
 * 1. 消息带固定 source 标记，避免和页面上其他 postMessage 串台；
 * 2. 每条消息带唯一 channelId，防止多个弹窗实例互相干扰；
 * 3. 接收方必须同时校验 event.origin（白名单）与 event.source（就是本次 window.open 的窗口）；
 * 4. 敏感结果（如支付凭证）只通过 postMessage 传递，不写 URL / document.referrer。
 */

export const POPUP_PROTOCOL_SOURCE = 'safe-navigation-kit/popup' as const;
export const POPUP_PROTOCOL_VERSION = 1 as const;

/**
 * 同源桥接页与打开方之间使用的 BroadcastChannel 名称。
 * BroadcastChannel 按同源隔离、且不依赖 window.opener，因此即使 COOP 触发了
 * 浏览上下文组切换、opener 变成 null，只要桥接页与打开方同源，消息仍可到达。
 */
export const POPUP_BROADCAST_CHANNEL = 'safe-navigation-kit:popup:v1' as const;

export type PopupMessageType =
  | 'ready' // 弹窗 / 桥接页加载完成，可以接收消息
  | 'success' // 流程成功，payload 为业务数据
  | 'error' // 流程失败
  | 'close' // 弹窗请求关闭自身
  | 'ping'
  | 'pong';

export interface PopupMessage<T = unknown> {
  source: typeof POPUP_PROTOCOL_SOURCE;
  version: typeof POPUP_PROTOCOL_VERSION;
  channelId: string;
  type: PopupMessageType;
  payload?: T;
}

/** 不依赖 DOM 类型的消息形状（event 的最小结构），方便在 Node / 测试中复用校验。 */
export interface MessageLike {
  origin: string;
  source: unknown;
  data: unknown;
}

export function createPopupMessage<T>(
  channelId: string,
  type: PopupMessageType,
  payload?: T,
): PopupMessage<T> {
  return {
    source: POPUP_PROTOCOL_SOURCE,
    version: POPUP_PROTOCOL_VERSION,
    channelId,
    type,
    payload,
  };
}

/** 结构校验：data 必须是本协议的消息。只做形状判断，origin/source 由调用方校验。 */
export function isPopupMessage(value: unknown): value is PopupMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.source === POPUP_PROTOCOL_SOURCE &&
    v.version === POPUP_PROTOCOL_VERSION &&
    typeof v.channelId === 'string' &&
    typeof v.type === 'string'
  );
}

export interface ValidatedMessageOptions {
  channelId: string;
  /** 允许的 origin 列表；桥接页场景通常只有本站 origin。 */
  allowedOrigins: readonly string[];
  /** 本次 window.open 返回的窗口引用，用于校验 event.source。 */
  expectedSource?: unknown;
}

export type MessageValidationResult =
  | { ok: true; message: PopupMessage }
  | { ok: false; reason: 'origin' | 'source' | 'shape' | 'channel' };

/**
 * 统一的消息校验器。客户端 PopupChannel 和 popup-bridge 页面共用，
 * 确保任何一条被信任的消息都通过 origin + source + channel 三重检查。
 */
export function validatePopupMessage(
  event: MessageLike,
  options: ValidatedMessageOptions,
): MessageValidationResult {
  if (!options.allowedOrigins.includes(event.origin)) {
    return { ok: false, reason: 'origin' };
  }
  if (options.expectedSource !== undefined && event.source !== options.expectedSource) {
    return { ok: false, reason: 'source' };
  }
  if (!isPopupMessage(event.data)) {
    return { ok: false, reason: 'shape' };
  }
  if (event.data.channelId !== options.channelId) {
    return { ok: false, reason: 'channel' };
  }
  return { ok: true, message: event.data };
}

/** 生成 channelId；优先使用 crypto.randomUUID，回退到随机串。 */
export function createChannelId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
