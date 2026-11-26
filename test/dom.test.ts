import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Window as HappyWindow } from "happy-dom";
import {
  TabnabbingGuard,
  installTabnabbingGuard,
} from "../src/browser/dom.ts";
import { DEFAULT_POLICY, type GuardPolicy } from "../src/shared/policy.ts";

const base = "https://community.example";

interface AnchorLike {
  rel: string;
  href: string;
  target: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  dispatchEvent(event: unknown): boolean;
  textContent: string;
}
interface FormLike {
  action: string;
  target: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}
interface TestDocument {
  body: {
    innerHTML: string;
    appendChild(node: unknown): unknown;
  };
  documentElement: unknown;
  baseURI: string;
  createElement(tag: string): AnchorLike & FormLike;
  querySelector<T>(selector: string): T | null;
  querySelectorAll<T>(selector: string): T[];
  addEventListener(type: string, fn: (e: unknown) => void, capture?: boolean): void;
  removeEventListener(type: string, fn: (e: unknown) => void, capture?: boolean): void;
}
interface TestWindow {
  location: { href: string; origin: string };
  document: TestDocument;
  open(...args: unknown[]): { opener: unknown; closed: boolean } | null;
  openCalls: unknown[][];
  Element: unknown;
  setTimeout(fn: () => void, ms?: number): number;
  MouseEvent: typeof MouseEvent;
}

function makeEnv(): { win: TestWindow; popups: Array<{ opener: unknown; closed: boolean }> } {
  const dom = new HappyWindow({ url: `${base}/feed` });
  const win = dom as unknown as TestWindow;
  const popups: Array<{ opener: unknown; closed: boolean }> = [];
  win.openCalls = [];
  win.open = ((...args: unknown[]) => {
    win.openCalls.push(args);
    const popup = { opener: win, closed: false };
    popups.push(popup);
    return popup;
  }) as TestWindow["open"];
  return { win, popups };
}

const policy: Partial<GuardPolicy> = {
  trustedPopupOrigins: ["https://login.trusted.example", "https://*.pay.example"],
};

function anchor(win: TestWindow, id: string): AnchorLike {
  return win.document.querySelector<AnchorLike>(`#${id}`)!;
}
function form(win: TestWindow, id: string): FormLike {
  return win.document.querySelector<FormLike>(`#${id}`)!;
}

describe("browser/dom TabnabbingGuard", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
  });

  it("安装时给所有 target=_blank 的外链补上 noopener noreferrer", () => {
    const { win } = env;
    win.document.body.innerHTML = `
      <a id="ext" href="https://evil.example/p" target="_blank">外链</a>
      <a id="self" href="/post/9" target="_blank">同源</a>
      <a id="plain" href="https://evil.example/p">普通链接</a>`;

    new TabnabbingGuard({ policy, context: win as unknown as Window }).install();

    assert.match(anchor(win, "ext").rel, /noopener/);
    assert.match(anchor(win, "ext").rel, /noreferrer/);
    // 同源新窗口默认也切断 opener（同源页面被攻破同样能反向跳转）
    assert.match(anchor(win, "self").rel, /noopener/);
    // 非新窗口目标不动
    assert.equal(anchor(win, "plain").rel, "");
  });

  it("白名单受信任弹窗链接移除 noopener，保留通信能力", () => {
    const { win } = env;
    win.document.body.innerHTML = `
      <a id="login" href="https://login.trusted.example/oauth" target="_blank" rel="noopener noreferrer">登录</a>
      <a id="pay" href="https://gateway.pay.example/checkout" target="_blank">支付</a>`;

    new TabnabbingGuard({ policy, context: win as unknown as Window }).install();

    assert.doesNotMatch(anchor(win, "login").rel, /noopener/);
    assert.doesNotMatch(anchor(win, "pay").rel, /noopener/);
  });

  it("策略允许时同源链接可保留 opener", () => {
    const { win } = env;
    win.document.body.innerHTML =
      '<a id="x" href="/inner" target="_blank" rel="noopener noreferrer">x</a>';

    new TabnabbingGuard({
      policy: { ...DEFAULT_POLICY, sameOriginKeepsOpener: true },
      context: win as unknown as Window,
    }).install();

    assert.doesNotMatch(anchor(win, "x").rel, /noopener/);
  });

  it("form target=_blank 同样按白名单加固", () => {
    const { win } = env;
    win.document.body.innerHTML = `
      <form id="f1" action="https://evil.example/submit" target="_blank"></form>
      <form id="f2" action="https://login.trusted.example/auth" target="_blank"></form>`;

    new TabnabbingGuard({ policy, context: win as unknown as Window }).install();

    // happy-dom 的 form 不反射 rel 属性，统一断言 getAttribute
    assert.match(form(win, "f1").getAttribute("rel") ?? "", /noopener/);
    assert.doesNotMatch(form(win, "f2").getAttribute("rel") ?? "", /noopener/);
  });

  it("MutationObserver 兜底动态插入的外链", async () => {
    const { win } = env;
    const guard = new TabnabbingGuard({
      policy,
      context: win as unknown as Window,
    }).install();

    const a = win.document.createElement("a");
    a.href = "https://evil.example/dynamic";
    a.target = "_blank";
    a.textContent = "动态链接";
    win.document.body.appendChild(a);

    await new Promise((resolve) => win.setTimeout(() => resolve(undefined), 0));
    assert.match(a.rel, /noopener/);

    // 动态修改 target 也会被捕获
    const b = win.document.createElement("a");
    b.href = "https://evil.example/late";
    win.document.body.appendChild(b);
    b.target = "_blank";
    await new Promise((resolve) => win.setTimeout(() => resolve(undefined), 0));
    assert.match(b.rel, /noopener/);

    guard.destroy();
  });

  it("捕获阶段点击委托在元素未被预先加固时同步补 rel", () => {
    const { win } = env;
    new TabnabbingGuard({ policy, context: win as unknown as Window }).install();

    const a = win.document.createElement("a");
    a.href = "https://evil.example/click";
    win.document.body.appendChild(a);
    a.setAttribute("target", "_blank");

    a.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    assert.match(a.rel, /noopener/);
  });

  it("右键/非主键点击不处理", () => {
    const { win } = env;
    new TabnabbingGuard({ policy, context: win as unknown as Window }).install();
    const a = win.document.createElement("a");
    a.href = "https://evil.example/right";
    a.target = "_blank";
    win.document.body.appendChild(a);

    a.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 2 }),
    );
    assert.equal(a.rel, "");
  });

  it("包装 window.open：外部 URL 强制 noopener（兼容路径置空 opener）", () => {
    const { win, popups } = env;
    new TabnabbingGuard({ policy, context: win as unknown as Window }).install();

    const popup = win.open("https://evil.example/share", "_blank", "popup");
    assert.equal(popup!.opener, null);
    assert.equal(popups[0]!.opener, null);
  });

  it("包装 window.open：白名单源保留 opener，第三方登录 SDK 不受影响", () => {
    const { win } = env;
    new TabnabbingGuard({ policy, context: win as unknown as Window }).install();

    const popup = win.open("https://login.trusted.example/sdk", "_blank", "popup");
    assert.equal(popup!.opener, win);
  });

  it("javascript: 等非 http 地址即使被 open 也不保留 opener", () => {
    const { win } = env;
    new TabnabbingGuard({ policy, context: win as unknown as Window }).install();
    const popup = win.open("javascript:alert(1)", "_blank");
    assert.equal(popup!.opener, null);
  });

  it("openTrustedPopup 对非白名单目标直接抛错，暴露配置问题", () => {
    const { win } = env;
    const guard = new TabnabbingGuard({
      policy,
      context: win as unknown as Window,
    }).install();
    assert.throws(
      () => guard.openTrustedPopup("https://evil.example/fake-login"),
      /trustedPopupOrigins/,
    );
  });

  it("openTrustedPopup 对白名单目标正常开窗且保留 opener", () => {
    const { win } = env;
    const guard = new TabnabbingGuard({
      policy,
      context: win as unknown as Window,
    }).install();
    const result = guard.openTrustedPopup("https://login.trusted.example/oauth");
    assert.equal(result.openerPreserved, true);
    assert.equal((result.win as { opener: unknown }).opener, win);
  });

  it("openExternal 永远切断 opener", () => {
    const { win } = env;
    const guard = new TabnabbingGuard({
      policy,
      context: win as unknown as Window,
    }).install();
    const result = guard.openExternal("https://evil.example/x");
    assert.equal(result.openerPreserved, false);
    assert.equal((result.win as { opener: unknown }).opener, null);
  });

  it("destroy 还原 window.open，重复安装有幂等保护", () => {
    const { win } = env;
    const original = win.open;
    const guard = installTabnabbingGuard({
      policy,
      context: win as unknown as Window,
    });
    assert.notEqual(win.open, original);

    // 第二次安装不会再包一层
    installTabnabbingGuard({ policy, context: win as unknown as Window });

    guard.destroy();
    assert.equal(win.open, original);
  });

  it("destroy 后再 install 抛错，避免使用失效实例", () => {
    const { win } = env;
    const guard = new TabnabbingGuard({ context: win as unknown as Window });
    guard.install();
    guard.destroy();
    assert.throws(() => guard.install(), /destroy/);
  });
});
