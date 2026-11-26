/**
 * 原生 Node http 服务器适配：
 * - 每个响应统一注入 COOP + Referrer-Policy
 * - 暴露 /redirect 安全跳转端点
 * 框架项目（Express/Koa/Fastify）可直接复用 buildSecurityHeaders
 * 与 safeRedirectHandler，按各自中间件签名薄封装。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applySecurityHeaders,
} from "./headers.js";
import { safeRedirectHandler } from "./redirect.js";
import type { GuardPolicy } from "../shared/policy.js";

export interface NodeMiddlewareOptions {
  readonly policy?: Partial<GuardPolicy>;
  /** 安全跳转端点路径，默认 /redirect */
  readonly redirectPath?: string;
}

/**
 * 返回一个可直接挂到 http.createServer 的前置处理函数。
 * 返回 true 表示请求已被中间件终结（如安全跳转），调用方应停止后续处理。
 */
export function createSecurityMiddleware(
  options: NodeMiddlewareOptions = {},
) {
  const policy = options.policy ?? {};
  const redirectPath = options.redirectPath ?? "/redirect";
  const handleRedirect = safeRedirectHandler({ policy });

  return function securityMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    applySecurityHeaders(res, { policy, pathname });
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (pathname === redirectPath) {
      handleRedirect(
        {
          url: req.url ?? "/",
          headers: { host: req.headers.host },
          socket: { encrypted: (req.socket as { encrypted?: boolean }).encrypted },
        },
        res,
      );
      return true;
    }
    return false;
  };
}
