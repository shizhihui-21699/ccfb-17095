/**
 * 服务端开放重定向防护。
 *
 * 反向 tabnabbing 的服务端变体：/redirect?to=//evil.com 这类接口若不校验，
 * 可把用户从站内可信页面送到外站，配合 Referer 泄露与钓鱼落地页。
 * 这里复用 shared/url 的同一套白名单口径。
 */
import { type GuardPolicy } from "../shared/policy.js";
export type RedirectDecision = {
    readonly allowed: true;
    readonly url: URL;
    readonly sameOrigin: boolean;
} | {
    readonly allowed: false;
    readonly reason: string;
};
/**
 * 校验跳转目标。
 *
 * @param destination 待校验 URL（相对路径或绝对地址）
 * @param requestOrigin 当前站点源，作为相对地址解析基准
 */
export declare function planRedirect(destination: string, requestOrigin: string, policy?: GuardPolicy): RedirectDecision;
/** 框架无关的最小请求/响应形状，方便适配 Express 与原生 Node */
export interface MinimalRequest {
    readonly url: string;
    readonly headers: {
        readonly host?: string | undefined;
    };
    /** 显式覆盖站点源（反向代理场景建议传入 trust proxy 后的原始源） */
    readonly origin?: string;
    readonly socket?: {
        readonly encrypted?: boolean | undefined;
    };
}
export interface MinimalResponse {
    setHeader(name: string, value: string): void;
    statusCode: number;
    end(body?: string): void;
}
export interface RedirectMiddlewareOptions {
    readonly policy?: Partial<GuardPolicy>;
    /** 取目标参数的参数名，默认 to */
    readonly paramName?: string;
    /** 拒绝时的站内落地页，默认 / */
    readonly fallbackPath?: string;
}
/**
 * 安全跳转中间件（Express 风格签名，原生 Node 也可手动适配）。
 * 校验失败不把错误细节回显给用户，而是 302 到站内安全落地页，
 * reason 仅作为返回值/日志供服务端审计。
 */
export declare function safeRedirectHandler(options?: RedirectMiddlewareOptions): (req: MinimalRequest, res: MinimalResponse) => {
    readonly decision: RedirectDecision;
};
