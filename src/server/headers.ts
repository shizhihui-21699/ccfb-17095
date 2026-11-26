/**
 * 服务端安全头：COOP 上下文隔离 + Referrer-Policy。
 *
 * 与前端 noopener 的分工：
 * - noopener 切断“新页面 -> 原页面”的 window.opener 引用
 * - COOP 让跨源文档进入独立的浏览上下文组，浏览器层面隔离
 * - Referrer-Policy 防止完整 URL（含会话参数）通过 Referer 泄露给外站
 * 三者互补，任一层被旧浏览器/特殊路径绕过，其余层仍能兜底。
 */
import {
  DEFAULT_POLICY,
  type CoopMode,
  type GuardPolicy,
} from "../shared/policy.js";

export interface SecurityHeaders {
  readonly "Cross-Origin-Opener-Policy": string;
  readonly "Referrer-Policy": string;
}

const COOP_HEADER_VALUE: Record<CoopMode, string> = {
  "same-origin": "same-origin",
  "same-origin-allow-popups": "same-origin-allow-popups",
  "unsafe-none": "unsafe-none",
};

export interface HeaderOptions {
  readonly policy?: Partial<GuardPolicy>;
  /** 当前请求路径，用于匹配 COOP 豁免前缀 */
  readonly pathname?: string;
}

/** 判断当前路由是否豁免 COOP（如第三方登录回跳页需要与弹窗同上下文） */
export function isCoopExempt(
  pathname: string,
  policy: GuardPolicy = DEFAULT_POLICY,
): boolean {
  // 按路径段匹配：/oauth/callback 与 /oauth/callback/x 命中，
  // /oauth/callback-evil 这种字符串前缀巧合不命中
  return policy.coopExemptPathPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

/**
 * 生成安全头。豁免路由显式返回 unsafe-none，让浏览器覆盖可能已缓存的强策略；
 * 正常路由默认 same-origin-allow-popups，兼顾受信任弹窗通信。
 */
export function buildSecurityHeaders(
  options: HeaderOptions = {},
): SecurityHeaders {
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  const exempt =
    options.pathname !== undefined && isCoopExempt(options.pathname, policy);

  const coop = exempt ? "unsafe-none" : policy.coop;
  return {
    "Cross-Origin-Opener-Policy": COOP_HEADER_VALUE[coop],
    "Referrer-Policy": policy.referrerPolicy,
  };
}

/** 极简框架无关的响应头写入接口，Node/Express/Fetch Handler 都能适配 */
export interface HeaderSink {
  setHeader(name: string, value: string): void;
}

/** 直接写到 Node 风格 ServerResponse / Express response */
export function applySecurityHeaders(
  res: HeaderSink,
  options: HeaderOptions = {},
): SecurityHeaders {
  const headers = buildSecurityHeaders(options);
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  return headers;
}

/**
 * HTML 兜底 meta 标签。适用于无法控制响应头的静态托管场景；
 * 注意 meta 不支持 COOP，COOP 必须由真正的 HTTP 响应头下发。
 */
export function buildReferrerMeta(policy: GuardPolicy = DEFAULT_POLICY): string {
  return `<meta name="referrer" content="${policy.referrerPolicy}">`;
}
