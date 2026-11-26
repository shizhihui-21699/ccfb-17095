import { applySecurityHeaders, } from "./headers.js";
import { safeRedirectHandler } from "./redirect.js";
/**
 * 返回一个可直接挂到 http.createServer 的前置处理函数。
 * 返回 true 表示请求已被中间件终结（如安全跳转），调用方应停止后续处理。
 */
export function createSecurityMiddleware(options = {}) {
    const policy = options.policy ?? {};
    const redirectPath = options.redirectPath ?? "/redirect";
    const handleRedirect = safeRedirectHandler({ policy });
    return function securityMiddleware(req, res) {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        applySecurityHeaders(res, { policy, pathname });
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (pathname === redirectPath) {
            handleRedirect({
                url: req.url ?? "/",
                headers: { host: req.headers.host },
                socket: { encrypted: req.socket.encrypted },
            }, res);
            return true;
        }
        return false;
    };
}
//# sourceMappingURL=middleware.js.map