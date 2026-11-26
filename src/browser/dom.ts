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
import { DEFAULT_POLICY, type GuardPolicy } from "../shared/policy.js";
import { mergeRelTokens, removeRelTokens, splitRel } from "../shared/rel.js";
import { isOriginAllowed, parseUrl } from "../shared/url.js";
import { safeOpen, type SafeOpenResult } from "./safeOpen.js";

export interface GuardInstallOptions {
  readonly policy?: Partial<GuardPolicy>;
  /** 加固范围根节点，默认 document.documentElement */
  readonly root?: ParentNode;
  readonly context?: Window;
}

const NOOPENER = "noopener";
const NOREFERRER = "noreferrer";

interface Marker {
  __tabnabbingGuardInstalled?: boolean;
  __tabnabbingGuardOriginalOpen?: typeof window.open;
}

export class TabnabbingGuard {
  readonly policy: GuardPolicy;
  private readonly win: Window;
  private readonly doc: Document;
  private readonly root: ParentNode;
  private observer: MutationObserver | null = null;
  private destroyed = false;
  /**
   * 正在被守卫写入的元素。setAttribute('rel') 本身会触发 MutationObserver，
   * 不做重入保护会形成“回调里改属性 -> 再触发回调”的自激循环（部分 DOM 实现
   * 不会去重）。WeakSet 让标记随元素一起回收，不产生内存泄漏。
   */
  private readonly mutating = new WeakSet<Element>();

  constructor(options: GuardInstallOptions = {}) {
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    this.win = options.context ?? window;
    this.doc = this.win.document;
    this.root = options.root ?? this.doc.documentElement;
  }

  /** 当前文档源，作为相对 URL 的解析基准与同源判断基准 */
  private get baseOrigin(): string {
    return this.doc.baseURI ? new URL(this.doc.baseURI).origin : this.win.location.origin;
  }

  /** 判断链接目标是否命中受信任弹窗白名单 */
  private isTrustedTarget(href: string): boolean {
    const url = parseUrl(href, this.doc.baseURI || this.win.location.href);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return false;
    }
    return isOriginAllowed(url.origin, this.policy.trustedPopupOrigins);
  }

  private isBlankTarget(target: string | null): boolean {
    // target 缺省是 _self；只有显式新窗口目标才需要处理
    return target === "_blank" || target === "_new";
  }

  /**
   * 统一的 rel 写入入口。值未变化时不写 DOM（幂等，避免无谓的 mutation）；
   * 写入期间在 WeakSet 中标记元素，observer 回调据此忽略自身触发的记录。
   */
  private setRel(el: Element, value: string | null): void {
    const current = el.getAttribute("rel");
    if (value === null) {
      if (current === null) return;
      this.mutating.add(el);
      try {
        el.removeAttribute("rel");
      } finally {
        this.mutating.delete(el);
      }
      return;
    }
    if (current === value) return;
    this.mutating.add(el);
    try {
      el.setAttribute("rel", value);
    } finally {
      this.mutating.delete(el);
    }
  }

  /**
   * 加固一个 <a>/<area>：
   * - 受信任弹窗：确保没有 noopener（业务要靠 opener 通信），是否带 noreferrer 由策略决定
   * - 同源：默认也加 noopener，同源页面被攻破同样能反向跳转
   * - 跨源/无法识别：强制 noopener + noreferrer
   */
  private hardenAnchor(el: HTMLAnchorElement | HTMLAreaElement): void {
    if (this.mutating.has(el)) return;
    const href = el.getAttribute("href");
    if (!href || href.startsWith("#")) return;

    if (!this.isBlankTarget(el.getAttribute("target"))) return;

    if (this.isTrustedTarget(href)) {
      this.setRel(el, removeRelTokens(el.getAttribute("rel"), [NOOPENER]));
      return;
    }

    const required = splitRel(this.policy.externalRel);
    // 同源场景默认仍切断 opener；仅当策略显式允许同源保留 opener 时放行
    const sameOrigin =
      parseUrl(href, this.doc.baseURI || this.win.location.href)?.origin ===
      this.baseOrigin;
    if (sameOrigin && this.policy.sameOriginKeepsOpener) {
      const kept = removeRelTokens(el.getAttribute("rel"), [
        NOOPENER,
        NOREFERRER,
      ]);
      this.setRel(el, kept || null);
      return;
    }
    this.setRel(el, mergeRelTokens(el.getAttribute("rel"), required));
  }

  /**
   * 加固 <form target=_blank>：HTML 表单 rel 属性控制新窗口的 opener 行为，
   * 同样按白名单决定保留或切断。
   */
  private hardenForm(el: HTMLFormElement): void {
    if (this.mutating.has(el)) return;
    if (!this.isBlankTarget(el.getAttribute("target"))) return;
    const action = el.getAttribute("action") ?? this.win.location.href;

    if (this.isTrustedTarget(action)) {
      const cleaned = removeRelTokens(el.getAttribute("rel"), [NOOPENER]);
      this.setRel(el, cleaned || null);
      return;
    }

    this.setRel(
      el,
      mergeRelTokens(el.getAttribute("rel"), splitRel(this.policy.externalRel)),
    );
  }

  private hardenAll(): void {
    const anchors = this.root.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>(
      "a[target], area[target]",
    );
    anchors.forEach((el) => this.hardenAnchor(el));
    this.root
      .querySelectorAll<HTMLFormElement>("form[target]")
      .forEach((el) => this.hardenForm(el));
  }

  /** 捕获阶段委托：框架动态改 DOM、Observer 尚未触发时的同步兜底 */
  private readonly onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a, area") as
      | HTMLAnchorElement
      | HTMLAreaElement
      | null;
    if (anchor) this.hardenAnchor(anchor);
  };

  private readonly onSubmit = (event: Event): void => {
    if (event.defaultPrevented) return;
    const form = (event.target as Element | null)?.closest?.("form") as
      | HTMLFormElement
      | null;
    if (form) this.hardenForm(form);
  };

  /**
   * 包装 window.open。所有 JS 开窗路径（含分享、弹窗 SDK）都会经过这里：
   * 默认 noopener；仅当目标源命中白名单时才保留 opener —— 受信任源本来
   * 就是业务允许通信的对象，因此按 URL 源判定足够安全，无需额外调用约定。
   */
  private patchWindowOpen(): void {
    const w = this.win as Window & Marker;
    if (w.__tabnabbingGuardInstalled) return; // 防重复安装
    // 保存原始引用本身（不要 bind 出一个新函数），destroy 时才能原样还原
    const originalOpen = w.open;
    w.__tabnabbingGuardOriginalOpen = originalOpen;
    // 保存绑定版本供 safeOpen 回调，保证 this 仍是 window
    const boundOriginalOpen = originalOpen.bind(w);

    const policy = this.policy;
    const self = this;
    w.open = function patchedOpen(
      url?: string | URL,
      target?: string,
      features?: string,
    ): Window | null {
      const rawUrl = url === undefined ? "" : String(url);
      const result = safeOpen(rawUrl, policy, {
        // safeOpen 内部仍会重新解析并校验白名单，这里的 trusted 只是短路
        trusted: true,
        windowName: target ?? "_blank",
        features: features ?? "",
        context: self.win,
        // 关键：回调未被包装的原始 open，杜绝 patchedOpen 重入
        openFn: boundOriginalOpen,
      });
      return result.win;
    };
    w.__tabnabbingGuardInstalled = true;
  }

  private startObserver(): void {
    // 必须取窗口自身的 MutationObserver，不能引用 ambient 全局，
    // 否则在 iframe/测试 DOM 等跨 realm 场景会拿错构造器或判定为 undefined
    const ObserverCtor = (
      this.win as Window & { MutationObserver?: typeof MutationObserver }
    ).MutationObserver;
    if (typeof ObserverCtor === "undefined") return;
    this.observer = new ObserverCtor((records: MutationRecord[]) => {
      for (const record of records) {
        if (record.type === "attributes") {
          const el = record.target as Element;
          if (el.tagName === "A" || el.tagName === "AREA") {
            this.hardenAnchor(el as HTMLAnchorElement);
          } else if (el.tagName === "FORM") {
            this.hardenForm(el as HTMLFormElement);
          }
          continue;
        }
        record.addedNodes.forEach((node: Node) => {
          // 跨 window 场景不能用 instanceof Element（不同 realm 构造器不同），
          // 用 nodeType 判定元素节点最稳
          if (node.nodeType !== 1) return;
          const el = node as Element;
          if (el.tagName === "A" || el.tagName === "AREA") {
            this.hardenAnchor(el as HTMLAnchorElement);
          } else if (el.tagName === "FORM") {
            this.hardenForm(el as HTMLFormElement);
          }
          el
            .querySelectorAll?.("a[target], area[target], form[target]")
            .forEach((child) => {
              if (child.tagName === "FORM") this.hardenForm(child as HTMLFormElement);
              else this.hardenAnchor(child as HTMLAnchorElement);
            });
        });
      }
    });
    this.observer!.observe(this.root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["target", "href", "rel", "action"],
    });
  }

  /** 安装全部防线，幂等 */
  install(): this {
    if (this.destroyed) {
      throw new Error("guard 已 destroy，请重新创建实例");
    }
    this.hardenAll();
    this.doc.addEventListener("click", this.onClick, true);
    this.doc.addEventListener("submit", this.onSubmit, true);
    this.patchWindowOpen();
    this.startObserver();
    return this;
  }

  /**
   * 业务方开受信任弹窗的唯一入口。未命中白名单会直接抛错，
   * 让配置错误在测试阶段暴露，而不是静默降级成无 opener 的弹窗。
   */
  openTrustedPopup(
    url: string,
    windowName = "_blank",
    features = "popup,width=480,height=720",
  ): SafeOpenResult {
    const origin = parseUrl(url, this.win.location.href)?.origin;
    if (!origin || !isOriginAllowed(origin, this.policy.trustedPopupOrigins)) {
      throw new Error(
        `目标源不在 trustedPopupOrigins 白名单中，拒绝保留 opener: ${url}`,
      );
    }
    return safeOpen(url, this.policy, {
      trusted: true,
      windowName,
      features,
      context: this.win,
    });
  }

  /** 普通开窗（评论外链、分享等），强制 noopener */
  openExternal(
    url: string,
    windowName = "_blank",
    features?: string,
  ): SafeOpenResult {
    return safeOpen(url, this.policy, {
      windowName,
      features: features ?? "",
      context: this.win,
    });
  }

  /** 卸载守卫：还原 window.open、断开 Observer 与事件 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.doc.removeEventListener("click", this.onClick, true);
    this.doc.removeEventListener("submit", this.onSubmit, true);

    const w = this.win as Window & Marker;
    if (w.__tabnabbingGuardOriginalOpen) {
      w.open = w.__tabnabbingGuardOriginalOpen;
      delete w.__tabnabbingGuardOriginalOpen;
    }
    delete w.__tabnabbingGuardInstalled;
  }
}

/** 推荐入口：一行安装 */
export function installTabnabbingGuard(
  options: GuardInstallOptions = {},
): TabnabbingGuard {
  return new TabnabbingGuard(options).install();
}
