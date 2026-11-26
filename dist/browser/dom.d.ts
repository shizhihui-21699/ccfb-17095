/**
 * TabnabbingGuard —— 浏览器端总守卫。
 *
 * 四条防线：
 * 1. 启动时 + MutationObserver 持续加固所有 target=_blank 的 <a>/<area>/<form>
 * 2. 捕获阶段事件委托，处理动态创建或被框架改写后未及加固的元素
 * 3. 包装 window.open，让所有代码路径（含第三方 SDK）默认 noopener
 * 4. 白名单窄门：trusted 标记 + 策略白名单双命中才保留 opener
 *
 * 用法：
 *   const guard = installTabnabbingGuard({ policy, root: document.documentElement });
 *   guard.openTrustedPopup("/oauth/login", ...);  // 业务方开受信任弹窗
 *   guard.destroy();                               // 热更新/测试清理
 */
import { type GuardPolicy } from "../shared/policy.js";
import { type SafeOpenResult } from "./safeOpen.js";
export interface GuardInstallOptions {
    readonly policy?: Partial<GuardPolicy>;
    /** 加固范围根节点，默认 document.documentElement */
    readonly root?: ParentNode;
    readonly context?: Window;
}
export declare class TabnabbingGuard {
    readonly policy: GuardPolicy;
    private readonly win;
    private readonly doc;
    private readonly root;
    private observer;
    private destroyed;
    /**
     * 正在被守卫写入的元素。setAttribute('rel') 本身会触发 MutationObserver，
     * 不做重入保护会形成“回调里改属性 -> 再触发回调”的自激循环（部分 DOM 实现
     * 不会去重）。WeakSet 让标记随元素一起回收，不产生内存泄漏。
     */
    private readonly mutating;
    constructor(options?: GuardInstallOptions);
    /** 当前文档源，作为相对 URL 的解析基准与同源判断基准 */
    private get baseOrigin();
    /** 判断链接目标是否命中受信任弹窗白名单 */
    private isTrustedTarget;
    private isBlankTarget;
    /**
     * 统一的 rel 写入入口。值未变化时不写 DOM（幂等，避免无谓的 mutation）；
     * 写入期间在 WeakSet 中标记元素，observer 回调据此忽略自身触发的记录。
     */
    private setRel;
    /**
     * 加固一个 <a>/<area>：
     * - 受信任弹窗：确保没有 noopener（业务要靠 opener 通信），是否带 noreferrer 由策略决定
     * - 同源：默认也加 noopener，同源页面被攻破同样能反向跳转
     * - 跨源/无法识别：强制 noopener + noreferrer
     */
    private hardenAnchor;
    /**
     * 加固 <form target=_blank>：HTML 表单 rel 属性控制新窗口的 opener 行为，
     * 同样按白名单决定保留或切断。
     */
    private hardenForm;
    private hardenAll;
    /** 捕获阶段委托：框架动态改 DOM、Observer 尚未触发时的同步兜底 */
    private readonly onClick;
    private readonly onSubmit;
    /**
     * 包装 window.open。所有 JS 开窗路径（含分享、弹窗 SDK）都会经过这里：
     * 默认 noopener；仅当目标源命中白名单时才保留 opener —— 受信任源本来
     * 就是业务允许通信的对象，因此按 URL 源判定足够安全，无需额外调用约定。
     */
    private patchWindowOpen;
    private startObserver;
    /** 安装全部防线，幂等 */
    install(): this;
    /**
     * 业务方开受信任弹窗的唯一入口。未命中白名单会直接抛错，
     * 让配置错误在测试阶段暴露，而不是静默降级成无 opener 的弹窗。
     */
    openTrustedPopup(url: string, windowName?: string, features?: string): SafeOpenResult;
    /** 普通开窗（评论外链、分享等），强制 noopener */
    openExternal(url: string, windowName?: string, features?: string): SafeOpenResult;
    /** 卸载守卫：还原 window.open、断开 Observer 与事件 */
    destroy(): void;
}
/** 推荐入口：一行安装 */
export declare function installTabnabbingGuard(options?: GuardInstallOptions): TabnabbingGuard;
