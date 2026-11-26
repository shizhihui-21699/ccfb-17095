export type CoopMode = "same-origin" | "same-origin-allow-popups" | "unsafe-none";
export interface GuardPolicy {
    /**
     * 受信任的第三方源（OAuth 登录、支付网关等）。
     * 只有命中此名单的弹窗可以保留 window.opener 与父页面通信，
     * 其它一切新窗口默认 noopener。
     */
    readonly trustedPopupOrigins: readonly string[];
    /** 跨站链接强制携带的 rel */
    readonly externalRel: string;
    /** 同源 target=_blank 是否保留 opener，默认不保留 */
    readonly sameOriginKeepsOpener: boolean;
    /**
     * 服务端 COOP 响应头：
     * - same-origin：最强隔离，跨源弹窗与本页彻底分家（第三方弹窗通信会断）
     * - same-origin-allow-popups：保留受信任弹窗的通信能力（推荐默认）
     * - unsafe-none：显式关闭隔离，只应出现在豁免路由上
     */
    readonly coop: CoopMode;
    /** 豁免 COOP 的路由前缀（如第三方登录回跳落地页） */
    readonly coopExemptPathPrefixes: readonly string[];
    /** Referrer-Policy 响应头 */
    readonly referrerPolicy: string;
    /** 服务端开放重定向防护白名单（/redirect?to= 这类接口用） */
    readonly allowedRedirectOrigins: readonly string[];
}
export declare const DEFAULT_POLICY: GuardPolicy;
/** 用部分配置覆盖默认值，数组字段整体替换而非拼接，语义更可预期 */
export declare function resolvePolicy(override?: Partial<GuardPolicy>): GuardPolicy;
export type LinkClassification = "trusted" | "same-origin" | "cross-origin" | "non-http";
/**
 * 把一个目标 URL 归类，浏览器端的 rel 决策与服务端的跳转校验都基于它。
 * 默认拒绝：任何无法明确识别为“受信任/同源”的目标都按外部不可信处理。
 */
export declare function classifyTarget(target: string, baseOrigin: string, policy: GuardPolicy): LinkClassification;
