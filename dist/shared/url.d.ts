/**
 * 共享的 URL 工具：浏览器端和服务端复用同一套源判断逻辑，
 * 避免两端各自实现导致白名单口径不一致。
 */
export type UrlInput = string | URL;
/** 宽松解析，失败返回 null 而不是抛异常 */
export declare function parseUrl(input: UrlInput, base?: string | URL): URL | null;
/** 只认可 http/https，javascript:、data:、file: 等一律视为不可信 */
export declare function isHttpUrl(url: URL): boolean;
/**
 * 提取源。非 http(s)（blob:、data:、mailto: 等）返回 null，
 * 调用方应按“默认不可信”处理。
 */
export declare function safeOrigin(input: UrlInput, base?: string | URL): string | null;
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
export declare function originMatches(actualOrigin: string, pattern: string): boolean;
export declare function isOriginAllowed(origin: string, allowlist: readonly string[]): boolean;
