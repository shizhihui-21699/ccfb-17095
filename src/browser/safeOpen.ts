/**
 * 浏览器端安全开窗原语。
 *
 * 核心原则：默认 noopener，只有显式声明 trusted 且命中策略白名单时
 * 才保留 opener —— 第三方登录/支付弹窗走这条窄门。
 */
import { isOriginAllowed, parseUrl } from "../shared/url.js";
import type { GuardPolicy } from "../shared/policy.js";

export interface SafeOpenOptions {
  /** 声明这是受信任的业务弹窗（OAuth/支付），仍需命中白名单才真正保留 opener */
  readonly trusted?: boolean;
  /** 窗口名，默认 _blank */
  readonly windowName?: string;
  /** window.open 的 features 串，如 "popup,width=480,height=720" */
  readonly features?: string;
  /** 显式传入 window，方便测试与多 iframe 场景 */
  readonly context?: Window;
  /**
   * 注入原始开窗函数。守卫包装 window.open 后，内部必须通过它回调
   * 未被包装的原始实现，否则 patchedOpen -> safeOpen -> win.open 无限重入。
   */
  readonly openFn?: typeof window.open;
}

export interface SafeOpenResult {
  readonly win: Window | null;
  /** 实际是否保留了 opener，调用方可据此做防御性断言 */
  readonly openerPreserved: boolean;
}

/** 探测浏览器是否支持 window.open 的 noopener feature token */
function supportsNoopener(win: Window): boolean {
  try {
    const a = win.document.createElement("a");
    return typeof a.relList?.supports === "function"
      ? a.relList.supports("noopener")
      : false;
  } catch {
    return false;
  }
}

function mergeFeatures(features: string | undefined, tokens: string[]): string {
  const parts = (features ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set(parts.map((p) => p.toLowerCase()));
  for (const token of tokens) {
    if (!seen.has(token.toLowerCase())) {
      seen.add(token.toLowerCase());
      parts.push(token);
    }
  }
  return parts.join(",");
}

/**
 * 安全打开新窗口/标签页。
 *
 * @param url 目标地址
 * @param policy 统一策略（白名单以它为准）
 */
export function safeOpen(
  url: string,
  policy: GuardPolicy,
  options: SafeOpenOptions = {},
): SafeOpenResult {
  const win = options.context ?? window;
  const target = options.windowName ?? "_blank";
  // 默认走 win.open；包装器场景注入原始实现以避免重入
  const openFn = options.openFn ?? win.open.bind(win);

  // 白名单判定：无法解析为 http(s) 的地址永远不可信
  const origin = parseUrl(url, win.location.href)?.origin ?? null;
  const trusted =
    options.trusted === true &&
    origin !== null &&
    isOriginAllowed(origin, policy.trustedPopupOrigins);

  if (trusted) {
    // 窄门：命中白名单的登录/支付弹窗，保留 opener 供 postMessage 通信
    return {
      win: openFn(url, target, options.features ?? ""),
      openerPreserved: true,
    };
  }

  // 默认路径：切断 opener。现代浏览器用 noopener feature，老浏览器开窗后置空
  if (supportsNoopener(win)) {
    const features = mergeFeatures(options.features, [
      "noopener",
      "noreferrer",
    ]);
    return { win: openFn(url, target, features), openerPreserved: false };
  }

  const opened = openFn(url, target, options.features ?? "");
  try {
    if (opened) opened.opener = null;
  } catch {
    // 跨源访问受限的极端环境下置空可能抛错，忽略：noopener 缺失时还有 COOP 兜底
  }
  return { win: opened, openerPreserved: false };
}

export interface PopupMessageOptions<T> {
  /** 弹窗源，必须精确指定；传 "*" 会直接拒绝，防止任意源伪造消息 */
  readonly expectedOrigin: string;
  /** 只接受匹配 type 字段的消息 */
  readonly messageType?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** 数据形状校验（如 Zod type guard），不通过的消息被忽略 */
  readonly validate?: (data: unknown) => data is T;
  readonly context?: Window;
}

/**
 * 监听受信任弹窗回传给父页面的消息。
 * 校验 source 与 origin 双因子，超时/弹窗被关闭/AbortSignal 都会拒绝。
 */
export function waitForPopupMessage<T>(
  popup: Window,
  options: PopupMessageOptions<T>,
): Promise<T> {
  const win = options.context ?? window;
  const timeoutMs = options.timeoutMs ?? 120_000;

  if (options.expectedOrigin === "*" || options.expectedOrigin === "") {
    return Promise.reject(
      new Error("expectedOrigin 必须是精确源，禁止使用通配符"),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const cleanupFns: Array<() => void> = [];
    let settled = false;

    const cleanup = (): void => {
      cleanupFns.forEach((fn) => fn());
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onMessage = (event: MessageEvent): void => {
      // 双因子：消息必须来自我们打开的那个弹窗，且源精确匹配
      if (event.source !== popup) return;
      if (event.origin !== options.expectedOrigin) return;

      const data = event.data as unknown;
      if (
        options.messageType !== undefined &&
        (typeof data !== "object" ||
          data === null ||
          (data as { type?: unknown }).type !== options.messageType)
      ) {
        return;
      }
      if (options.validate && !options.validate(data)) return;

      if (settled) return;
      settled = true;
      cleanup();
      resolve(data as T);
    };

    win.addEventListener("message", onMessage);
    cleanupFns.push(() => win.removeEventListener("message", onMessage));

    const timer = win.setTimeout(
      () => fail(new Error("等待弹窗消息超时")),
      timeoutMs,
    );
    cleanupFns.push(() => win.clearTimeout(timer));

    // 用户手动关掉弹窗时及时失败，避免 Promise 悬挂
    const closedChecker = win.setInterval(() => {
      if (popup.closed) fail(new Error("弹窗已被关闭"));
    }, 500);
    cleanupFns.push(() => win.clearInterval(closedChecker));

    if (options.signal) {
      if (options.signal.aborted) {
        fail(new Error("等待弹窗消息被中止"));
        return;
      }
      const onAbort = (): void =>
        fail(new Error("等待弹窗消息被中止"));
      options.signal.addEventListener("abort", onAbort, { once: true });
      cleanupFns.push(() =>
        options.signal?.removeEventListener("abort", onAbort),
      );
    }
  });
}

/**
 * 弹窗侧（回跳落地页）向原窗口回消息。
 * targetOrigin 必须显式指定父页面源，杜绝把令牌广播给任意监听者。
 */
export function postToOpener(
  message: unknown,
  targetOrigin: string,
  context: Window = window,
): boolean {
  if (!context.opener) return false;
  if (!targetOrigin || targetOrigin === "*") {
    throw new Error("postToOpener 必须指定精确的 targetOrigin");
  }
  context.opener.postMessage(message, targetOrigin);
  return true;
}
