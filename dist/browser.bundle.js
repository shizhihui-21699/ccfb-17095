"use strict";
var TabnabbingGuard = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/browser/index.ts
  var index_exports = {};
  __export(index_exports, {
    TabnabbingGuard: () => TabnabbingGuard,
    installTabnabbingGuard: () => installTabnabbingGuard,
    postToOpener: () => postToOpener,
    safeOpen: () => safeOpen,
    waitForPopupMessage: () => waitForPopupMessage
  });

  // src/shared/url.ts
  function parseUrl(input, base) {
    try {
      return new URL(input, base);
    } catch {
      return null;
    }
  }
  function isHttpUrl(url) {
    return url.protocol === "http:" || url.protocol === "https:";
  }
  function originMatches(actualOrigin, pattern) {
    if (pattern === "*") return true;
    const patternUrl = parseUrl(pattern);
    if (!patternUrl || !isHttpUrl(patternUrl)) return false;
    if (patternUrl.pathname !== "/" || patternUrl.search || patternUrl.hash) {
      return false;
    }
    const actualUrl = parseUrl(actualOrigin);
    if (!actualUrl) return false;
    const wildcardLabel = "*.";
    const patternHost = patternUrl.hostname;
    if (patternHost.startsWith(wildcardLabel)) {
      const suffix = patternHost.slice(wildcardLabel.length);
      const host = actualUrl.hostname;
      return actualUrl.protocol === patternUrl.protocol && host.endsWith("." + suffix) && host.length > suffix.length + 1;
    }
    return actualUrl.origin === patternUrl.origin;
  }
  function isOriginAllowed(origin, allowlist) {
    return allowlist.some((pattern) => originMatches(origin, pattern));
  }

  // src/shared/policy.ts
  var DEFAULT_POLICY = {
    trustedPopupOrigins: [],
    externalRel: "noopener noreferrer",
    sameOriginKeepsOpener: false,
    coop: "same-origin-allow-popups",
    coopExemptPathPrefixes: [],
    referrerPolicy: "strict-origin-when-cross-origin",
    allowedRedirectOrigins: []
  };

  // src/shared/rel.ts
  function splitRel(rel) {
    if (!rel) return [];
    const seen = /* @__PURE__ */ new Set();
    const tokens = [];
    for (const token of rel.trim().split(/\s+/)) {
      const lower = token.toLowerCase();
      if (lower && !seen.has(lower)) {
        seen.add(lower);
        tokens.push(lower);
      }
    }
    return tokens;
  }
  function mergeRelTokens(existing, required) {
    const tokens = splitRel(existing);
    const seen = new Set(tokens);
    for (const token of required) {
      const lower = token.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        tokens.push(lower);
      }
    }
    return tokens.join(" ");
  }
  function removeRelTokens(existing, removed) {
    const drop = new Set(removed.map((t) => t.toLowerCase()));
    return splitRel(existing).filter((token) => !drop.has(token)).join(" ");
  }

  // src/browser/safeOpen.ts
  function supportsNoopener(win) {
    try {
      const a = win.document.createElement("a");
      return typeof a.relList?.supports === "function" ? a.relList.supports("noopener") : false;
    } catch {
      return false;
    }
  }
  function mergeFeatures(features, tokens) {
    const parts = (features ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const seen = new Set(parts.map((p) => p.toLowerCase()));
    for (const token of tokens) {
      if (!seen.has(token.toLowerCase())) {
        seen.add(token.toLowerCase());
        parts.push(token);
      }
    }
    return parts.join(",");
  }
  function safeOpen(url, policy, options = {}) {
    const win = options.context ?? window;
    const target = options.windowName ?? "_blank";
    const openFn = options.openFn ?? win.open.bind(win);
    const origin = parseUrl(url, win.location.href)?.origin ?? null;
    const trusted = options.trusted === true && origin !== null && isOriginAllowed(origin, policy.trustedPopupOrigins);
    if (trusted) {
      return {
        win: openFn(url, target, options.features ?? ""),
        openerPreserved: true
      };
    }
    if (supportsNoopener(win)) {
      const features = mergeFeatures(options.features, [
        "noopener",
        "noreferrer"
      ]);
      return { win: openFn(url, target, features), openerPreserved: false };
    }
    const opened = openFn(url, target, options.features ?? "");
    try {
      if (opened) opened.opener = null;
    } catch {
    }
    return { win: opened, openerPreserved: false };
  }
  function waitForPopupMessage(popup, options) {
    const win = options.context ?? window;
    const timeoutMs = options.timeoutMs ?? 12e4;
    if (options.expectedOrigin === "*" || options.expectedOrigin === "") {
      return Promise.reject(
        new Error("expectedOrigin \u5FC5\u987B\u662F\u7CBE\u786E\u6E90\uFF0C\u7981\u6B62\u4F7F\u7528\u901A\u914D\u7B26")
      );
    }
    return new Promise((resolve, reject) => {
      const cleanupFns = [];
      let settled = false;
      const cleanup = () => {
        cleanupFns.forEach((fn) => fn());
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onMessage = (event) => {
        if (event.source !== popup) return;
        if (event.origin !== options.expectedOrigin) return;
        const data = event.data;
        if (options.messageType !== void 0 && (typeof data !== "object" || data === null || data.type !== options.messageType)) {
          return;
        }
        if (options.validate && !options.validate(data)) return;
        if (settled) return;
        settled = true;
        cleanup();
        resolve(data);
      };
      win.addEventListener("message", onMessage);
      cleanupFns.push(() => win.removeEventListener("message", onMessage));
      const timer = win.setTimeout(
        () => fail(new Error("\u7B49\u5F85\u5F39\u7A97\u6D88\u606F\u8D85\u65F6")),
        timeoutMs
      );
      cleanupFns.push(() => win.clearTimeout(timer));
      const closedChecker = win.setInterval(() => {
        if (popup.closed) fail(new Error("\u5F39\u7A97\u5DF2\u88AB\u5173\u95ED"));
      }, 500);
      cleanupFns.push(() => win.clearInterval(closedChecker));
      if (options.signal) {
        if (options.signal.aborted) {
          fail(new Error("\u7B49\u5F85\u5F39\u7A97\u6D88\u606F\u88AB\u4E2D\u6B62"));
          return;
        }
        const onAbort = () => fail(new Error("\u7B49\u5F85\u5F39\u7A97\u6D88\u606F\u88AB\u4E2D\u6B62"));
        options.signal.addEventListener("abort", onAbort, { once: true });
        cleanupFns.push(
          () => options.signal?.removeEventListener("abort", onAbort)
        );
      }
    });
  }
  function postToOpener(message, targetOrigin, context = window) {
    if (!context.opener) return false;
    if (!targetOrigin || targetOrigin === "*") {
      throw new Error("postToOpener \u5FC5\u987B\u6307\u5B9A\u7CBE\u786E\u7684 targetOrigin");
    }
    context.opener.postMessage(message, targetOrigin);
    return true;
  }

  // src/browser/dom.ts
  var NOOPENER = "noopener";
  var NOREFERRER = "noreferrer";
  var TabnabbingGuard = class {
    constructor(options = {}) {
      __publicField(this, "policy");
      __publicField(this, "win");
      __publicField(this, "doc");
      __publicField(this, "root");
      __publicField(this, "observer", null);
      __publicField(this, "destroyed", false);
      /**
       * 正在被守卫写入的元素。setAttribute('rel') 本身会触发 MutationObserver，
       * 不做重入保护会形成“回调里改属性 -> 再触发回调”的自激循环（部分 DOM 实现
       * 不会去重）。WeakSet 让标记随元素一起回收，不产生内存泄漏。
       */
      __publicField(this, "mutating", /* @__PURE__ */ new WeakSet());
      /** 捕获阶段委托：框架动态改 DOM、Observer 尚未触发时的同步兜底 */
      __publicField(this, "onClick", (event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        const target = event.target;
        const anchor = target?.closest?.("a, area");
        if (anchor) this.hardenAnchor(anchor);
      });
      __publicField(this, "onSubmit", (event) => {
        if (event.defaultPrevented) return;
        const form = event.target?.closest?.("form");
        if (form) this.hardenForm(form);
      });
      this.policy = { ...DEFAULT_POLICY, ...options.policy };
      this.win = options.context ?? window;
      this.doc = this.win.document;
      this.root = options.root ?? this.doc.documentElement;
    }
    /** 当前文档源，作为相对 URL 的解析基准与同源判断基准 */
    get baseOrigin() {
      return this.doc.baseURI ? new URL(this.doc.baseURI).origin : this.win.location.origin;
    }
    /** 判断链接目标是否命中受信任弹窗白名单 */
    isTrustedTarget(href) {
      const url = parseUrl(href, this.doc.baseURI || this.win.location.href);
      if (!url || url.protocol !== "http:" && url.protocol !== "https:") {
        return false;
      }
      return isOriginAllowed(url.origin, this.policy.trustedPopupOrigins);
    }
    isBlankTarget(target) {
      return target === "_blank" || target === "_new";
    }
    /**
     * 统一的 rel 写入入口。值未变化时不写 DOM（幂等，避免无谓的 mutation）；
     * 写入期间在 WeakSet 中标记元素，observer 回调据此忽略自身触发的记录。
     */
    setRel(el, value) {
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
    hardenAnchor(el) {
      if (this.mutating.has(el)) return;
      const href = el.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (!this.isBlankTarget(el.getAttribute("target"))) return;
      if (this.isTrustedTarget(href)) {
        this.setRel(el, removeRelTokens(el.getAttribute("rel"), [NOOPENER]));
        return;
      }
      const required = splitRel(this.policy.externalRel);
      const sameOrigin = parseUrl(href, this.doc.baseURI || this.win.location.href)?.origin === this.baseOrigin;
      if (sameOrigin && this.policy.sameOriginKeepsOpener) {
        const kept = removeRelTokens(el.getAttribute("rel"), [
          NOOPENER,
          NOREFERRER
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
    hardenForm(el) {
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
        mergeRelTokens(el.getAttribute("rel"), splitRel(this.policy.externalRel))
      );
    }
    hardenAll() {
      const anchors = this.root.querySelectorAll(
        "a[target], area[target]"
      );
      anchors.forEach((el) => this.hardenAnchor(el));
      this.root.querySelectorAll("form[target]").forEach((el) => this.hardenForm(el));
    }
    /**
     * 包装 window.open。所有 JS 开窗路径（含分享、弹窗 SDK）都会经过这里：
     * 默认 noopener；仅当目标源命中白名单时才保留 opener —— 受信任源本来
     * 就是业务允许通信的对象，因此按 URL 源判定足够安全，无需额外调用约定。
     */
    patchWindowOpen() {
      const w = this.win;
      if (w.__tabnabbingGuardInstalled) return;
      const originalOpen = w.open;
      w.__tabnabbingGuardOriginalOpen = originalOpen;
      const boundOriginalOpen = originalOpen.bind(w);
      const policy = this.policy;
      const self = this;
      w.open = function patchedOpen(url, target, features) {
        const rawUrl = url === void 0 ? "" : String(url);
        const result = safeOpen(rawUrl, policy, {
          // safeOpen 内部仍会重新解析并校验白名单，这里的 trusted 只是短路
          trusted: true,
          windowName: target ?? "_blank",
          features: features ?? "",
          context: self.win,
          // 关键：回调未被包装的原始 open，杜绝 patchedOpen 重入
          openFn: boundOriginalOpen
        });
        return result.win;
      };
      w.__tabnabbingGuardInstalled = true;
    }
    startObserver() {
      const ObserverCtor = this.win.MutationObserver;
      if (typeof ObserverCtor === "undefined") return;
      this.observer = new ObserverCtor((records) => {
        for (const record of records) {
          if (record.type === "attributes") {
            const el = record.target;
            if (el.tagName === "A" || el.tagName === "AREA") {
              this.hardenAnchor(el);
            } else if (el.tagName === "FORM") {
              this.hardenForm(el);
            }
            continue;
          }
          record.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            const el = node;
            if (el.tagName === "A" || el.tagName === "AREA") {
              this.hardenAnchor(el);
            } else if (el.tagName === "FORM") {
              this.hardenForm(el);
            }
            el.querySelectorAll?.("a[target], area[target], form[target]").forEach((child) => {
              if (child.tagName === "FORM") this.hardenForm(child);
              else this.hardenAnchor(child);
            });
          });
        }
      });
      this.observer.observe(this.root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["target", "href", "rel", "action"]
      });
    }
    /** 安装全部防线，幂等 */
    install() {
      if (this.destroyed) {
        throw new Error("guard \u5DF2 destroy\uFF0C\u8BF7\u91CD\u65B0\u521B\u5EFA\u5B9E\u4F8B");
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
    openTrustedPopup(url, windowName = "_blank", features = "popup,width=480,height=720") {
      const origin = parseUrl(url, this.win.location.href)?.origin;
      if (!origin || !isOriginAllowed(origin, this.policy.trustedPopupOrigins)) {
        throw new Error(
          `\u76EE\u6807\u6E90\u4E0D\u5728 trustedPopupOrigins \u767D\u540D\u5355\u4E2D\uFF0C\u62D2\u7EDD\u4FDD\u7559 opener: ${url}`
        );
      }
      return safeOpen(url, this.policy, {
        trusted: true,
        windowName,
        features,
        context: this.win
      });
    }
    /** 普通开窗（评论外链、分享等），强制 noopener */
    openExternal(url, windowName = "_blank", features) {
      return safeOpen(url, this.policy, {
        windowName,
        features: features ?? "",
        context: this.win
      });
    }
    /** 卸载守卫：还原 window.open、断开 Observer 与事件 */
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.observer?.disconnect();
      this.observer = null;
      this.doc.removeEventListener("click", this.onClick, true);
      this.doc.removeEventListener("submit", this.onSubmit, true);
      const w = this.win;
      if (w.__tabnabbingGuardOriginalOpen) {
        w.open = w.__tabnabbingGuardOriginalOpen;
        delete w.__tabnabbingGuardOriginalOpen;
      }
      delete w.__tabnabbingGuardInstalled;
    }
  };
  function installTabnabbingGuard(options = {}) {
    return new TabnabbingGuard(options).install();
  }
  return __toCommonJS(index_exports);
})();
//# sourceMappingURL=browser.bundle.js.map
