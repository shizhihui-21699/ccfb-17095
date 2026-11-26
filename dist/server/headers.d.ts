/**
 * 服务端安全头：COOP 上下文隔离 + Referrer-Policy。
 *
 * 与前端 noopener 的分工：
 * - noopener 切断“新页面 -> 原页面”的 window.opener 引用
 * - COOP 让跨源文档进入独立的浏览上下文组，浏览器层面隔离
 * - Referrer-Policy 防止完整 URL（含会话参数）通过 Referer 泄露给外站
 * 三者互补，任一层被旧浏览器/特殊路径绕过，其余层仍能兜底。
 */
import { type GuardPolicy } from "../shared/policy.js";
export interface SecurityHeaders {
    readonly "Cross-Origin-Opener-Policy": string;
    readonly "Referrer-Policy": string;
}
export interface HeaderOptions {
    readonly policy?: Partial<GuardPolicy>;
    /** 当前请求路径，用于匹配 COOP 豁免前缀 */
    readonly pathname?: string;
}
/** 判断当前路由是否豁免 COOP（如第三方登录回跳页需要与弹窗同上下文） */
export declare function isCoopExempt(pathname: string, policy?: GuardPolicy): boolean;
/**
 * 生成安全头。豁免路由显式返回 unsafe-none，让浏览器覆盖可能已缓存的强策略；
 * 正常路由默认 same-origin-allow-popups，兼顾受信任弹窗通信。
 */
export declare function buildSecurityHeaders(options?: HeaderOptions): SecurityHeaders;
/** 极简框架无关的响应头写入接口，Node/Express/Fetch Handler 都能适配 */
export interface HeaderSink {
    setHeader(name: string, value: string): void;
}
/** 直接写到 Node 风格 ServerResponse / Express response */
export declare function applySecurityHeaders(res: HeaderSink, options?: HeaderOptions): SecurityHeaders;
/**
 * HTML 兜底 meta 标签。适用于无法控制响应头的静态托管场景；
 * 注意 meta 不支持 COOP，COOP 必须由真正的 HTTP 响应头下发。
 */
export declare function buildReferrerMeta(policy?: GuardPolicy): string;
