/**
 * 服务端开放重定向防护。
 *
 * 反向 tabnabbing 的服务端变体：/redirect?to=//evil.com 这类接口若不校验，
 * 可把用户从站内可信页面送到外站，配合 Referer 泄露与钓鱼落地页。
 * 这里复用 shared/url 的同一套白名单口径。
 */
import { DEFAULT_POLICY, } from "../shared/policy.js";
import { isOriginAllowed, parseUrl } from "../shared/url.js";
/** 拒绝一切包含控制字符/换行的目标，防止响应头 CRLF 注入 */
function hasControlChars(value) {
    // C0 控制区（0x00-0x1F，含 CR/LF/Tab）、DEL(0x7F) 与 C1 控制区（0x80-0x9F）
    // eslint-disable-next-line no-control-regex
    return /[\x00-\x1F\x7F-\x9F]/.test(value);
}
/**
 * 校验跳转目标。
 *
 * @param destination 待校验 URL（相对路径或绝对地址）
 * @param requestOrigin 当前站点源，作为相对地址解析基准
 */
export function planRedirect(destination, requestOrigin, policy = DEFAULT_POLICY) {
    if (!destination || typeof destination !== "string") {
        return { allowed: false, reason: "空的跳转目标" };
    }
    if (hasControlChars(destination)) {
        return { allowed: false, reason: "目标包含非法控制字符" };
    }
    const url = parseUrl(destination, requestOrigin);
    if (!url) {
        return { allowed: false, reason: "无法解析的 URL" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { allowed: false, reason: `禁止的协议: ${url.protocol}` };
    }
    if (url.origin === requestOrigin) {
        return { allowed: true, url, sameOrigin: true };
    }
    if (isOriginAllowed(url.origin, policy.allowedRedirectOrigins)) {
        return { allowed: true, url, sameOrigin: false };
    }
    return {
        allowed: false,
        reason: `目标源不在跳转白名单: ${url.origin}`,
    };
}
/** 从请求推导本站源；生产环境在反向代理后应显式传 req.origin */
function deriveRequestOrigin(req) {
    if (req.origin)
        return req.origin;
    const host = req.headers.host ?? "localhost";
    const protocol = req.socket?.encrypted ? "https:" : "http:";
    return `${protocol}//${host}`;
}
/**
 * 安全跳转中间件（Express 风格签名，原生 Node 也可手动适配）。
 * 校验失败不把错误细节回显给用户，而是 302 到站内安全落地页，
 * reason 仅作为返回值/日志供服务端审计。
 */
export function safeRedirectHandler(options = {}) {
    const policy = { ...DEFAULT_POLICY, ...options.policy };
    const paramName = options.paramName ?? "to";
    const fallbackPath = options.fallbackPath ?? "/";
    return function handleRedirect(req, res) {
        const requestOrigin = deriveRequestOrigin(req);
        const requestUrl = parseUrl(req.url, requestOrigin);
        const destination = requestUrl?.searchParams.get(paramName) ?? "";
        const decision = planRedirect(destination, requestOrigin, policy);
        // 安全头在任何响应路径上都要带上
        res.setHeader("Referrer-Policy", policy.referrerPolicy);
        if (!decision.allowed) {
            // 审计点：真实系统应在此记录结构化日志，不要把 reason 原样回显
            res.statusCode = 302;
            res.setHeader("Location", fallbackPath);
            res.end();
            return { decision };
        }
        res.statusCode = 302;
        // 外站跳转不带 Referer，避免会话 URL 泄露
        if (!decision.sameOrigin) {
            res.setHeader("Referrer-Policy", "no-referrer");
        }
        res.setHeader("Location", decision.url.toString());
        res.end();
        return { decision };
    };
}
//# sourceMappingURL=redirect.js.map