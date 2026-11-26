/**
 * 共享的 URL 工具：浏览器端和服务端复用同一套源判断逻辑，
 * 避免两端各自实现导致白名单口径不一致。
 */
/** 宽松解析，失败返回 null 而不是抛异常 */
export function parseUrl(input, base) {
    try {
        return new URL(input, base);
    }
    catch {
        return null;
    }
}
/** 只认可 http/https，javascript:、data:、file: 等一律视为不可信 */
export function isHttpUrl(url) {
    return url.protocol === "http:" || url.protocol === "https:";
}
/**
 * 提取源。非 http(s)（blob:、data:、mailto: 等）返回 null，
 * 调用方应按“默认不可信”处理。
 */
export function safeOrigin(input, base) {
    const url = parseUrl(input, base);
    if (!url || !isHttpUrl(url))
        return null;
    return url.origin;
}
/**
 * 判断一个实际源是否匹配白名单条目。
 *
 * 支持三种写法：
 *   "https://pay.example.com"      精确匹配源（协议+主机+端口）
 *   "https://*.example.com"        匹配任意层级子域，不含裸域 example.com
 *   "*"                            匹配所有源（逃生舱，不建议）
 *
 * 注意：只比较“源”，条目中的路径会被忽略并视为配置错误。
 */
export function originMatches(actualOrigin, pattern) {
    if (pattern === "*")
        return true;
    const patternUrl = parseUrl(pattern);
    if (!patternUrl || !isHttpUrl(patternUrl))
        return false;
    if (patternUrl.pathname !== "/" || patternUrl.search || patternUrl.hash) {
        // 白名单只允许源粒度，带路径的条目不生效
        return false;
    }
    const actualUrl = parseUrl(actualOrigin);
    if (!actualUrl)
        return false;
    const wildcardLabel = "*.";
    const patternHost = patternUrl.hostname;
    if (patternHost.startsWith(wildcardLabel)) {
        const suffix = patternHost.slice(wildcardLabel.length);
        const host = actualUrl.hostname;
        // 只匹配子域：a.example.com / a.b.example.com 命中，裸域不命中
        return (actualUrl.protocol === patternUrl.protocol
            && host.endsWith("." + suffix)
            && host.length > suffix.length + 1);
    }
    // URL.origin 已规范化默认端口，直接比较源即可
    return actualUrl.origin === patternUrl.origin;
}
export function isOriginAllowed(origin, allowlist) {
    return allowlist.some((pattern) => originMatches(origin, pattern));
}
//# sourceMappingURL=url.js.map