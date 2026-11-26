/**
 * 浏览器端安全开窗原语。
 *
 * 核心原则：默认 noopener，只有显式声明 trusted 且命中策略白名单时
 * 才保留 opener —— 第三方登录/支付弹窗走这条窄门。
 */
import { isOriginAllowed, parseUrl } from "../shared/url.js";
/** 探测浏览器是否支持 window.open 的 noopener feature token */
function supportsNoopener(win) {
    try {
        const a = win.document.createElement("a");
        return typeof a.relList?.supports === "function"
            ? a.relList.supports("noopener")
            : false;
    }
    catch {
        return false;
    }
}
function mergeFeatures(features, tokens) {
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
export function safeOpen(url, policy, options = {}) {
    const win = options.context ?? window;
    const target = options.windowName ?? "_blank";
    // 默认走 win.open；包装器场景注入原始实现以避免重入
    const openFn = options.openFn ?? win.open.bind(win);
    // 白名单判定：无法解析为 http(s) 的地址永远不可信
    const origin = parseUrl(url, win.location.href)?.origin ?? null;
    const trusted = options.trusted === true &&
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
        if (opened)
            opened.opener = null;
    }
    catch {
        // 跨源访问受限的极端环境下置空可能抛错，忽略：noopener 缺失时还有 COOP 兜底
    }
    return { win: opened, openerPreserved: false };
}
/**
 * 监听受信任弹窗回传给父页面的消息。
 * 校验 source 与 origin 双因子，超时/弹窗被关闭/AbortSignal 都会拒绝。
 */
export function waitForPopupMessage(popup, options) {
    const win = options.context ?? window;
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (options.expectedOrigin === "*" || options.expectedOrigin === "") {
        return Promise.reject(new Error("expectedOrigin 必须是精确源，禁止使用通配符"));
    }
    return new Promise((resolve, reject) => {
        const cleanupFns = [];
        let settled = false;
        const cleanup = () => {
            cleanupFns.forEach((fn) => fn());
        };
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(err);
        };
        const onMessage = (event) => {
            // 双因子：消息必须来自我们打开的那个弹窗，且源精确匹配
            if (event.source !== popup)
                return;
            if (event.origin !== options.expectedOrigin)
                return;
            const data = event.data;
            if (options.messageType !== undefined &&
                (typeof data !== "object" ||
                    data === null ||
                    data.type !== options.messageType)) {
                return;
            }
            if (options.validate && !options.validate(data))
                return;
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(data);
        };
        win.addEventListener("message", onMessage);
        cleanupFns.push(() => win.removeEventListener("message", onMessage));
        const timer = win.setTimeout(() => fail(new Error("等待弹窗消息超时")), timeoutMs);
        cleanupFns.push(() => win.clearTimeout(timer));
        // 用户手动关掉弹窗时及时失败，避免 Promise 悬挂
        const closedChecker = win.setInterval(() => {
            if (popup.closed)
                fail(new Error("弹窗已被关闭"));
        }, 500);
        cleanupFns.push(() => win.clearInterval(closedChecker));
        if (options.signal) {
            if (options.signal.aborted) {
                fail(new Error("等待弹窗消息被中止"));
                return;
            }
            const onAbort = () => fail(new Error("等待弹窗消息被中止"));
            options.signal.addEventListener("abort", onAbort, { once: true });
            cleanupFns.push(() => options.signal?.removeEventListener("abort", onAbort));
        }
    });
}
/**
 * 弹窗侧（回跳落地页）向原窗口回消息。
 * targetOrigin 必须显式指定父页面源，杜绝把令牌广播给任意监听者。
 */
export function postToOpener(message, targetOrigin, context = window) {
    if (!context.opener)
        return false;
    if (!targetOrigin || targetOrigin === "*") {
        throw new Error("postToOpener 必须指定精确的 targetOrigin");
    }
    context.opener.postMessage(message, targetOrigin);
    return true;
}
//# sourceMappingURL=safeOpen.js.map