/**
 * PopupChannel —— 第三方登录 / 支付弹窗的安全通信通道。
 *
 * 与普通外链相反，这类弹窗【必须】保留 window.opener，因此不能加 noopener。
 * 安全性由以下机制保证：
 * - 目标 URL 必须命中受信 origin 白名单（由调用方 / window.open 守卫保证）；
 * - postMessage 通道只接受 allowedOrigins + event.source === 弹窗窗口 + channelId 匹配的消息；
 * - 同源桥接页还可走 BroadcastChannel：同源隔离、不依赖 opener，能穿越 COOP 上下文组切换；
 * - 带超时和窗口关闭检测，始终清理监听、BroadcastChannel 与定时器；
 * - 业务方拿到的是 Promise，不需要直接接触 postMessage。
 */

import {
  createChannelId,
  createPopupMessage,
  POPUP_BROADCAST_CHANNEL,
  validatePopupMessage,
  type PopupMessage,
} from '../shared/popup-protocol';

export interface PopupChannelOptions<TResult = unknown> {
  /** 提供方标识，例如 `github` / `stripe`，仅用于日志。 */
  provider: string;
  /** 允许 postMessage 回来的 origin（通常是提供方 origin + 本站桥接页 origin）。 */
  allowedOrigins: readonly string[];
  /** 弹窗参数。 */
  windowFeatures?: string;
  windowName?: string;
  /** 超时毫秒，默认 5 分钟。 */
  timeoutMs?: number;
  /** 轮询弹窗是否被直接关闭的间隔，默认 500ms。 */
  closePollMs?: number;
  /**
   * 检测到弹窗 closed 后，等待结果消息（含 BroadcastChannel）竞态到达的宽限毫秒，默认 300。
   * COOP 切换可能让一个仍然存活的弹窗的 WindowProxy 表现为 closed=true，宽限期可避免误杀。
   */
  closeGraceMs?: number;
  /** 是否启用 BroadcastChannel 备用传输，默认 true（环境支持时）。 */
  broadcast?: boolean;
  /** 弹窗成功消息的 type，默认 'success'。 */
  successType?: PopupMessage['type'];
  /** 在打开后是否立即向弹窗发送 ready/ping，默认发送 ping。 */
  announce?: boolean;
  /** 自定义全局对象（测试用）。 */
  targetWindow?: Window;
}

export class PopupBlockedError extends Error {
  constructor(message = '弹窗被浏览器拦截，请允许本站弹出窗口后重试') {
    super(message);
    this.name = 'PopupBlockedError';
  }
}

export class PopupTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`弹窗流程超时（${timeoutMs}ms）`);
    this.name = 'PopupTimeoutError';
  }
}

export class PopupClosedError extends Error {
  constructor() {
    super('弹窗在完成流程前被关闭');
    this.name = 'PopupClosedError';
  }
}

export class PopupProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PopupProtocolError';
  }
}

export interface PopupChannel<TResult = unknown> {
  readonly channelId: string;
  readonly provider: string;
  /** 底层窗口引用（保留 opener 通信所必需）。 */
  readonly popupWindow: Window | null;
  /** 流程成功 / 失败的 Promise。 */
  readonly result: Promise<TResult>;
  /** 主动关闭弹窗并清理监听。 */
  close(): void;
  /** 向弹窗发送消息（targetOrigin 固定为白名单中的 origin 时需调用方指定）。 */
  post(message: unknown, targetOrigin: string): void;
  /** 移除监听与定时器（不关闭窗口）。 */
  dispose(): void;
}

/**
 * 打开受信弹窗并建立校验通道。
 *
 * url 既可以是字符串，也可以是 `(channelId) => url` 工厂 —— 当第三方流程要求
 * 把本次通道 id 拼进 state / 查询参数（供桥接页回传）时使用工厂形式。
 *
 * 注意：这里的 window.open 【不能】带 noopener，否则第三方页面 / 桥接页
 * 无法通过 window.opener.postMessage 回传结果。
 */
export function openTrustedPopup<TResult = unknown>(
  url: string | ((channelId: string) => string),
  options: PopupChannelOptions<TResult>,
): PopupChannel<TResult> {
  const host = options.targetWindow ?? window;
  const channelId = createChannelId();
  const resolvedUrl = typeof url === 'function' ? url(channelId) : url;
  const features =
    options.windowFeatures ??
    'popup=yes,width=520,height=680,menubar=no,toolbar=no,location=yes,status=no,resizable=yes,scrollbars=yes';

  // 明确不加 noopener/noreferrer —— 这是刻意的，通信依赖 opener。
  const popupWindow = host.open(
    resolvedUrl,
    options.windowName ?? `popup-${options.provider}-${channelId}`,
    features,
  ) as Window | null;

  if (!popupWindow) {
    throw new PopupBlockedError();
  }

  let settled = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  let broadcast: BroadcastChannel | null = null;

  const cleanup = () => {
    if (messageHandler) host.removeEventListener('message', messageHandler);
    if (pollTimer) clearInterval(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (broadcast) {
      broadcast.onmessage = null;
      broadcast.close();
      broadcast = null;
    }
  };

  const result = new Promise<TResult>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    // 两种传输（window message / BroadcastChannel）校验通过后共用同一套结算逻辑。
    const settleFromMessage = (message: PopupMessage) => {
      if (message.type === (options.successType ?? 'success')) {
        finish(() => resolve(message.payload as TResult));
        try {
          popupWindow?.close();
        } catch {
          /* 跨域窗口 close 可能抛错，忽略 */
        }
      } else if (message.type === 'error') {
        finish(() =>
          reject(
            new PopupProtocolError(
              typeof message.payload === 'string' ? message.payload : '第三方流程返回错误',
            ),
          ),
        );
        try {
          popupWindow?.close();
        } catch {
          /* ignore */
        }
      } else if (message.type === 'close') {
        finish(() => reject(new PopupClosedError()));
        try {
          popupWindow?.close();
        } catch {
          /* ignore */
        }
      }
    };

    messageHandler = function onMessage(event: MessageEvent) {
      const validation = validatePopupMessage(
        event as unknown as { origin: string; source: unknown; data: unknown },
        { channelId, allowedOrigins: options.allowedOrigins, expectedSource: popupWindow },
      );
      if (!validation.ok) {
        // origin/source/channel/形状不匹配的消息一律忽略，不能抛异常影响宿主页面。
        return;
      }
      settleFromMessage(validation.message);
    };

    host.addEventListener('message', messageHandler);

    // BroadcastChannel 备用传输：同源桥接页可用，且不受 COOP 上下文组切换影响。
    const BCCtor =
      (host as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel ??
      (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    if (options.broadcast !== false && typeof BCCtor === 'function') {
      try {
        const bc = new BCCtor(POPUP_BROADCAST_CHANNEL);
        bc.onmessage = (event: MessageEvent) => {
          // BroadcastChannel 本身保证同源；这里仍做形状与 channelId 校验，
          // 随机 channelId 避免本站其他标签/实例串消息。
          const data = event.data as unknown;
          if (
            typeof data === 'object' &&
            data !== null &&
            (data as PopupMessage).channelId === channelId &&
            (data as PopupMessage).source !== undefined
          ) {
            settleFromMessage(data as PopupMessage);
          }
        };
        broadcast = bc;
      } catch {
        broadcast = null;
      }
    }

    pollTimer = setInterval(() => {
      if (settled || !popupWindow.closed) return;
      // COOP 切换可能让仍存活的弹窗引用误报 closed。给结果消息一个宽限窗口，
      // 宽限期内成功/失败消息仍可通过 finish 正常结算（settled 只允许第一次）。
      if (graceTimer) return;
      graceTimer = setTimeout(() => {
        finish(() => reject(new PopupClosedError()));
      }, options.closeGraceMs ?? 300);
    }, options.closePollMs ?? 500);

    timeoutTimer = setTimeout(() => {
      finish(() => reject(new PopupTimeoutError(options.timeoutMs ?? 5 * 60_000)));
      try {
        popupWindow.close();
      } catch {
        /* ignore */
      }
    }, options.timeoutMs ?? 5 * 60_000);

    if (options.announce !== false) {
      try {
        popupWindow.postMessage(createPopupMessage(channelId, 'ping'), options.allowedOrigins[0] ?? '*');
      } catch {
        /* 提供方可能尚未就绪，桥接页会主动发 ready，忽略 */
      }
    }
  });

  return {
    channelId,
    provider: options.provider,
    popupWindow,
    result,
    post(message: unknown, targetOrigin: string) {
      popupWindow.postMessage(message, targetOrigin);
    },
    close() {
      if (!settled) {
        settled = true;
        cleanup();
      }
      try {
        popupWindow.close();
      } catch {
        /* ignore */
      }
    },
    dispose() {
      if (!settled) {
        settled = true;
        cleanup();
      }
    },
  };
}

/**
 * 弹窗内 / popup-bridge 页使用：安全地把结果发回 window.opener。
 * targetOrigin 必须显式指定为本站 origin，绝不能用 '*' 携带敏感数据。
 */
export function postToOpener<T>(
  channelId: string,
  type: PopupMessage<T>['type'],
  payload: T | undefined,
  targetOrigin: string,
): boolean {
  if (window.opener) {
    window.opener.postMessage(createPopupMessage(channelId, type, payload), targetOrigin);
    return true;
  }
  return false;
}
