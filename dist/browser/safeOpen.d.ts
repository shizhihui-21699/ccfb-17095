import type { GuardPolicy } from "../shared/policy.js";
export interface SafeOpenOptions {
    /** 声明这是受信任的业务弹窗（OAuth/支付），仍需命中白名单才真正保留 opener */
    readonly trusted?: boolean;
    /** 窗口名，默认 _blank */
    readonly windowName?: string;
    /** window.open 的 features 串，如 "popup,width=480,height=720" */
    readonly features?: string;
    /** 显式传入 window，方便测试与多 iframe 场景 */
    readonly context?: Window;
    /**
     * 注入原始开窗函数。守卫包装 window.open 后，内部必须通过它回调
     * 未被包装的原始实现，否则 patchedOpen -> safeOpen -> win.open 无限重入。
     */
    readonly openFn?: typeof window.open;
}
export interface SafeOpenResult {
    readonly win: Window | null;
    /** 实际是否保留了 opener，调用方可据此做防御性断言 */
    readonly openerPreserved: boolean;
}
/**
 * 安全打开新窗口/标签页。
 *
 * @param url 目标地址
 * @param policy 统一策略（白名单以它为准）
 */
export declare function safeOpen(url: string, policy: GuardPolicy, options?: SafeOpenOptions): SafeOpenResult;
export interface PopupMessageOptions<T> {
    /** 弹窗源，必须精确指定；传 "*" 会直接拒绝，防止任意源伪造消息 */
    readonly expectedOrigin: string;
    /** 只接受匹配 type 字段的消息 */
    readonly messageType?: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    /** 数据形状校验（如 Zod type guard），不通过的消息被忽略 */
    readonly validate?: (data: unknown) => data is T;
    readonly context?: Window;
}
/**
 * 监听受信任弹窗回传给父页面的消息。
 * 校验 source 与 origin 双因子，超时/弹窗被关闭/AbortSignal 都会拒绝。
 */
export declare function waitForPopupMessage<T>(popup: Window, options: PopupMessageOptions<T>): Promise<T>;
/**
 * 弹窗侧（回跳落地页）向原窗口回消息。
 * targetOrigin 必须显式指定父页面源，杜绝把令牌广播给任意监听者。
 */
export declare function postToOpener(message: unknown, targetOrigin: string, context?: Window): boolean;
