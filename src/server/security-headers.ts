/**
 * 服务端浏览上下文隔离响应头（框架无关 + Express 适配）。
 *
 * 为什么选 Cross-Origin-Opener-Policy（COOP）：
 * - `same-origin`：最强隔离。跨源弹窗 / 新标签与原页面不在同一浏览上下文组，
 *   新页面拿不到 window.opener，反向标签劫持从浏览器进程层面被切断。
 *   但会破坏依赖 window.opener.postMessage 的第三方登录 / 支付弹窗。
 * - `same-origin-allow-popups`（本方案默认）：本站页面之间仍同组，且【允许】
 *   本站主动打开的弹窗保留 opener 引用 —— 正好兼容 OAuth / 支付弹窗通信；
 *   同时对“别人打开我们”以及跨源嵌套场景提供隔离。
 * - `unsafe-none`：仅用于必须与跨源窗口脚本级互操作的极少数页面。
 *
 * 推荐的渐进路线：
 *   全站先 `same-origin-allow-popups` + Report-Only 观察 → 确认弹窗白名单后，
 *   对不使用弹窗的页面（文章页、设置页等）按路由升级为 `same-origin`。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export type CoopValue = 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none';

export interface SecurityHeadersOptions {
  /**
   * 默认 COOP，默认 `same-origin-allow-popups`（兼容登录/支付弹窗）。
   * 可传函数按请求决定，例如对文章页返回 `same-origin`。
   */
  coop?: CoopValue | ((req: IncomingMessage) => CoopValue);
  /**
   * 仅上报不阻断：同时输出 Cross-Origin-Opener-Policy-Report-Only。
   * 配置 reportTo 后会带上 report-to / reporting-endpoints。
   */
  reportOnly?: boolean;
  reportTo?: string;
  /** Reporting-Endpoints 头内容，例如 `coop-endpoint="https://logs.example/coop"`。 */
  reportingEndpoints?: string;
  /** Referrer-Policy，默认 strict-origin-when-cross-origin。 */
  referrerPolicy?: string | false;
  /** 是否加 X-Content-Type-Options: nosniff，默认 true。 */
  noSniff?: boolean;
  /** 自定义额外头 / 覆盖。 */
  extraHeaders?: Record<string, string>;
}

export const DEFAULT_COOP: CoopValue = 'same-origin-allow-popups';

export function resolveCoop(req: IncomingMessage | undefined, options: SecurityHeadersOptions): CoopValue {
  if (typeof options.coop === 'function') {
    if (!req) return DEFAULT_COOP;
    return options.coop(req);
  }
  return options.coop ?? DEFAULT_COOP;
}

/** 计算应当设置的全部安全头（纯函数，方便单测）。 */
export function buildSecurityHeaders(
  req?: IncomingMessage,
  options: SecurityHeadersOptions = {},
): Record<string, string> {
  const coop = resolveCoop(req, options);
  const headerName = options.reportOnly
    ? 'Cross-Origin-Opener-Policy-Report-Only'
    : 'Cross-Origin-Opener-Policy';

  let coopValue: string = coop;
  if (options.reportOnly && options.reportTo) {
    coopValue = `${coop}; report-to="${options.reportTo}"`;
  }

  const headers: Record<string, string> = {
    [headerName]: coopValue,
  };

  if (options.reportTo && !options.reportOnly) {
    headers['Cross-Origin-Opener-Policy'] = `${coop}; report-to="${options.reportTo}"`;
  }
  if (options.reportingEndpoints) {
    headers['Reporting-Endpoints'] = options.reportingEndpoints;
  }

  const referrerPolicy =
    options.referrerPolicy === undefined ? 'strict-origin-when-cross-origin' : options.referrerPolicy;
  if (referrerPolicy) headers['Referrer-Policy'] = referrerPolicy;

  if (options.noSniff !== false) headers['X-Content-Type-Options'] = 'nosniff';

  Object.assign(headers, options.extraHeaders);
  return headers;
}

/** 框架无关：Node http 的 preflight 风格处理器。 */
export function applySecurityHeaders(
  res: ServerResponse,
  req?: IncomingMessage,
  options: SecurityHeadersOptions = {},
): void {
  const headers = buildSecurityHeaders(req, options);
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

/** Express / Connect 兼容中间件（不依赖 express 类型包）。 */
export function securityHeadersMiddleware(options: SecurityHeadersOptions = {}) {
  return function securityHeaders(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void {
    applySecurityHeaders(res, req, options);
    next();
  };
}

/**
 * 按路径选择 COOP 的便捷工厂。
 * @param sameOriginPrefixes 这些路径前缀使用最强的 same-origin（不得包含登录/支付弹窗流程）
 */
export function coopByPath(
  sameOriginPrefixes: readonly string[],
  fallback: CoopValue = 'same-origin-allow-popups',
): (req: IncomingMessage) => CoopValue {
  return (req) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    return sameOriginPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
      ? 'same-origin'
      : fallback;
  };
}
