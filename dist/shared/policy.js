/**
 * 统一安全策略。浏览器端与服务端共用同一份配置类型，
 * 建议由服务端下发一份 JSON，前端直接消费，保证口径一致。
 */
import { originMatches, parseUrl as parseUrlSafe } from "./url.js";
export const DEFAULT_POLICY = {
    trustedPopupOrigins: [],
    externalRel: "noopener noreferrer",
    sameOriginKeepsOpener: false,
    coop: "same-origin-allow-popups",
    coopExemptPathPrefixes: [],
    referrerPolicy: "strict-origin-when-cross-origin",
    allowedRedirectOrigins: [],
};
/** 用部分配置覆盖默认值，数组字段整体替换而非拼接，语义更可预期 */
export function resolvePolicy(override) {
    if (!override)
        return DEFAULT_POLICY;
    return { ...DEFAULT_POLICY, ...override };
}
/**
 * 把一个目标 URL 归类，浏览器端的 rel 决策与服务端的跳转校验都基于它。
 * 默认拒绝：任何无法明确识别为“受信任/同源”的目标都按外部不可信处理。
 */
export function classifyTarget(target, baseOrigin, policy) {
    const url = parseUrlSafe(target, baseOrigin);
    if (!url)
        return "cross-origin"; // 无法解析 -> 默认不可信
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "non-http";
    }
    if (url.origin === baseOrigin)
        return "same-origin";
    if (policy.trustedPopupOrigins.some((pattern) => originMatches(url.origin, pattern))) {
        return "trusted";
    }
    return "cross-origin";
}
//# sourceMappingURL=policy.js.map