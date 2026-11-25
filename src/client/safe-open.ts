/**
 * 前端统一打开入口。
 *
 * 全站任何“打开新窗口 / 新标签”的代码都应当走这里的函数，而不是直接调用
 * window.open 或手写 target="_blank"：
 *
 * - openExternal()       外部不可信链接：强制 noopener[,noreferrer]，返回 null（浏览器规范行为）
 * - openSameTab()         当前标签跳转：先做协议校验，防止 javascript: URL
 * - openTrustedPopup()    第三方登录/支付：保留 opener，走校验过的 postMessage 通道
 * - installWindowOpenGuard()  兜底接管遗留代码 / 第三方脚本对 window.open 的直接调用
 */

import {
  buildWindowFeatures,
  classifyUrl,
  isTrustedPopupOrigin,
  resolvePolicy,
  type NavigationPolicy,
} from '../shared/url-policy';

export interface OpenExternalOptions extends NavigationPolicy {
  /** window.open 的 windowFeatures（尺寸等）；默认打开为新标签，不带弹窗尺寸。 */
  features?: string | Record<string, string | number | boolean | undefined>;
  target?: string;
  /** 测试注入。 */
  targetWindow?: Window;
}

export class UnsafeUrlError extends Error {
  constructor(
    public readonly url: string,
    reason: string,
  ) {
    super(`拒绝打开不安全的 URL（${reason}）：${url}`);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * 打开外部不可信页面。等价于带 rel="noopener noreferrer" 的 target="_blank"。
 *
 * noopener 生效后 window.open 按规范返回 null，因此调用方无法（也不应）再操作新窗口。
 */
export function openExternal(rawUrl: string, options: OpenExternalOptions = {}): null {
  const host = options.targetWindow ?? window;
  const policy = resolvePolicy(options);
  const classified = classifyUrl(rawUrl, { ...policy, base: host.location?.href });

  if (!classified.ok) {
    throw new UnsafeUrlError(rawUrl, classified.reason);
  }
  if (!classified.isWeb) {
    // mailto:/tel: 交给系统处理；它们不会产生能访问 opener 的网页。
    host.location.href = rawUrl;
    return null;
  }

  const features = buildWindowFeatures(options.features, {
    noopener: true,
    noreferrer: policy.externalNoreferrer,
  });

  // 第三个参数即使为空字符串也显式传入，确保部分浏览器进入“弹窗”特性解析路径时 noopener 仍生效。
  host.open(rawUrl, options.target ?? '_blank', features || 'noopener,noreferrer');
  return null;
}

/** 当前标签跳转，同样做协议白名单校验。 */
export function openSameTab(rawUrl: string, options: NavigationPolicy & { targetWindow?: Window } = {}): void {
  const host = options.targetWindow ?? window;
  const policy = resolvePolicy(options);
  const classified = classifyUrl(rawUrl, { ...policy, base: host.location?.href });
  if (!classified.ok) throw new UnsafeUrlError(rawUrl, classified.reason);
  host.location.assign(rawUrl);
}

export interface WindowOpenGuardOptions extends NavigationPolicy {
  /**
   * 命中受信弹窗 origin 时保留 opener（登录/支付 SDK 自己调用 window.open 的场景）。
   * 未命中的 http(s) 外链一律强制 noopener。
   */
  trustedPopupOrigins?: readonly string[];
  /** 非 http(s) 协议（如 about:blank）的处理：allow 放行 / noopener 隔离 / block 抛错。 */
  nonWebProtocol?: 'allow' | 'noopener' | 'block';
  /** 记录被改写的调用，便于上报/排查。 */
  onRewrite?: (info: { url: string | URL; addedNoopener: boolean; trusted: boolean }) => void;
  targetWindow?: Window;
}

export interface WindowOpenGuard {
  restore(): void;
}

type GuardedWindow = Window & { __safeOpenGuardInstalled?: boolean };

/**
 * 接管全局 window.open，作为遗留代码和第三方 SDK 的兜底防线。
 *
 * 判定顺序：
 * 1. 受信弹窗 origin 白名单  -> 原样调用，保留 opener（不能弄坏登录/支付）
 * 2. http(s) 外链/内链       -> features 强制补 noopener
 * 3. about:blank 等          -> 按 nonWebProtocol 策略（默认 allow，因为很多 SDK 先开空白窗再跳转）
 * 4. javascript:/data: 等    -> 直接拒绝
 *
 * 注意：部分支付 SDK 会先 window.open('') 拿到窗口引用，再设置 form.target 提交。
 * 因此 about:blank 必须默认放行，否则会破坏这些流程。
 */
export function installWindowOpenGuard(options: WindowOpenGuardOptions = {}): WindowOpenGuard {
  const host = (options.targetWindow ?? window) as GuardedWindow;
  if (host.__safeOpenGuardInstalled) {
    return { restore() {} };
  }
  // 不使用 bind：保留原始函数引用，restore 时可以精确还原。
  const originalOpen = host.open;
  host.__safeOpenGuardInstalled = true;

  const guardedOpen = function guardedOpen(
    this: Window,
    url?: string | URL,
    target?: string,
    features?: string,
  ): Window | null {
    const rawUrl = url == null ? '' : String(url);
    const policy = resolvePolicy(options);

    // 空 URL / about:blank：SDK 常见的“先开窗后导航”模式，默认放行。
    if (rawUrl === '' || rawUrl === 'about:blank') {
      if (options.nonWebProtocol === 'block') {
        throw new UnsafeUrlError(rawUrl, 'empty-window-blocked');
      }
      return originalOpen.call(host, rawUrl, target, features);
    }

    const classified = classifyUrl(rawUrl, { ...policy, base: host.location?.href });
    if (!classified.ok) {
      // 危险协议不打开任何窗口。
      options.onRewrite?.({ url: rawUrl, addedNoopener: false, trusted: false });
      throw new UnsafeUrlError(rawUrl, classified.reason);
    }

    const trusted =
      classified.url != null &&
      isTrustedPopupOrigin(classified.url, options.trustedPopupOrigins ?? policy.trustedPopupOrigins);

    if (trusted) {
      options.onRewrite?.({ url: rawUrl, addedNoopener: false, trusted: true });
      return originalOpen.call(host, rawUrl, target, features);
    }

    if (classified.isWeb) {
      const safeFeatures = buildWindowFeatures(features, { noopener: true });
      options.onRewrite?.({ url: rawUrl, addedNoopener: true, trusted: false });
      // noopener 时原生返回 null，这里也如实返回。
      originalOpen.call(host, rawUrl, target ?? '_blank', safeFeatures);
      return null;
    }

    // mailto:/tel: 等
    if (options.nonWebProtocol === 'block') {
      throw new UnsafeUrlError(rawUrl, 'non-web-protocol-blocked');
    }
    return originalOpen.call(host, rawUrl, target, features);
  } as typeof window.open;

  host.open = guardedOpen;

  return {
    restore() {
      host.open = originalOpen;
      host.__safeOpenGuardInstalled = false;
    },
  };
}
