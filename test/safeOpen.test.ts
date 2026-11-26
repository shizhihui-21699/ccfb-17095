import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Window as HappyWindow } from "happy-dom";
import { safeOpen, waitForPopupMessage, postToOpener } from "../src/browser/safeOpen.ts";
import { DEFAULT_POLICY, type GuardPolicy } from "../src/shared/policy.ts";

const policy: GuardPolicy = {
  ...DEFAULT_POLICY,
  trustedPopupOrigins: ["https://login.trusted.example"],
};

/** 测试用结构化窗口接口，避免 happy-dom 类型与 lib.dom 的具体类冲突 */
interface TestWindow {
  location: { href: string; origin: string };
  document: {
    createElement(tag: string): {
      relList?: { supports(token: string): boolean };
    };
  };
  open(url?: string, target?: string, features?: string): { opener: unknown; closed: boolean } | null;
  openCalls: unknown[][];
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  dispatchEvent(event: unknown): void;
  MessageEvent: typeof MessageEvent;
  AbortController: typeof AbortController;
  opener: unknown;
}

function createWindow(): TestWindow {
  const dom = new HappyWindow({ url: "https://community.example/feed" });
  const win = dom as unknown as TestWindow;
  win.openCalls = [];
  const fakePopup = { opener: win, closed: false };
  win.open = ((...args: unknown[]) => {
    win.openCalls.push(args);
    return fakePopup;
  }) as TestWindow["open"];
  return win;
}

describe("browser/safeOpen", () => {
  let win: TestWindow;

  beforeEach(() => {
    win = createWindow();
  });

  it("外部地址默认 noopener：不支持 feature token 时走置空 opener 的兼容路径", () => {
    const result = safeOpen("https://evil.example/x", policy, {
      context: win as unknown as Window,
    });
    assert.equal(result.openerPreserved, false);
    assert.equal(win.openCalls.length, 1);
    assert.equal((result.win as { opener: unknown }).opener, null);
  });

  it("命中白名单且 trusted=true 时保留 opener，供 OAuth/支付通信", () => {
    const result = safeOpen("https://login.trusted.example/oauth", policy, {
      trusted: true,
      context: win as unknown as Window,
    });
    assert.equal(result.openerPreserved, true);
    assert.equal((result.win as { opener: unknown }).opener, win);
  });

  it("即使声明 trusted，未命中白名单也强制切断 opener", () => {
    const result = safeOpen("https://evil.example/oauth-lookalike", policy, {
      trusted: true,
      context: win as unknown as Window,
    });
    assert.equal(result.openerPreserved, false);
    assert.equal((result.win as { opener: unknown }).opener, null);
  });

  it("无法解析为 http(s) 的地址永远不可信", () => {
    const result = safeOpen("javascript:alert(1)", policy, {
      trusted: true,
      context: win as unknown as Window,
    });
    assert.equal(result.openerPreserved, false);
  });

  it("现代浏览器路径：relList 支持 noopener 时通过 features 传 noopener,noreferrer", () => {
    // happy-dom 的 relList 是只读代理、且不实现 supports，
    // 这里用最小化假窗口精确模拟“现代浏览器”能力探测结果
    const calls: unknown[][] = [];
    const fakeWin = {
      location: { href: "https://community.example/feed" },
      document: {
        createElement: () => ({
          relList: { supports: (token: string) => token === "noopener" },
        }),
      },
      open: (...args: unknown[]) => {
        calls.push(args);
        return { opener: fakeWin, closed: false };
      },
    } as unknown as Window;

    const result = safeOpen("https://evil.example/x", policy, {
      context: fakeWin,
      features: "popup,width=400",
    });
    assert.equal(result.openerPreserved, false);
    const features = calls[0]?.[2] as string;
    assert.match(features, /popup/);
    assert.match(features, /noopener/);
    assert.match(features, /noreferrer/);
  });

  it("waitForPopupMessage 拒绝通配 expectedOrigin", async () => {
    await assert.rejects(
      waitForPopupMessage({} as Window, {
        expectedOrigin: "*",
        context: win as unknown as Window,
      }),
      /禁止使用通配符/,
    );
  });

  it("waitForPopupMessage 只接受来源弹窗且源精确匹配的消息", async () => {
    const popup = { closed: false } as Window;
    const pending = waitForPopupMessage<{ type: string; code: string }>(popup, {
      expectedOrigin: "https://login.trusted.example",
      messageType: "oauth-result",
      validate: (d): d is { type: string; code: string } =>
        typeof d === "object" &&
        d !== null &&
        typeof (d as { code?: unknown }).code === "string",
      context: win as unknown as Window,
    });

    // 来源不对（其它窗口的消息）：忽略
    win.dispatchEvent(
      new win.MessageEvent("message", {
        data: { type: "oauth-result", code: "stolen" },
        origin: "https://login.trusted.example",
        source: {} as Window,
      }),
    );
    // 源不对：忽略
    win.dispatchEvent(
      new win.MessageEvent("message", {
        data: { type: "oauth-result", code: "phish" },
        origin: "https://evil.example",
        source: popup,
      }),
    );
    // 合法消息：通过
    win.dispatchEvent(
      new win.MessageEvent("message", {
        data: { type: "oauth-result", code: "abc123" },
        origin: "https://login.trusted.example",
        source: popup,
      }),
    );

    const data = await pending;
    assert.equal(data.code, "abc123");
  });

  it("waitForPopupMessage 在弹窗被关闭时拒绝", async () => {
    const popup = { closed: false } as Window;
    const pending = waitForPopupMessage(popup, {
      expectedOrigin: "https://login.trusted.example",
      context: win as unknown as Window,
    });
    (popup as { closed: boolean }).closed = true;
    await assert.rejects(pending, /弹窗已被关闭/);
  });

  it("waitForPopupMessage 支持 AbortSignal 中止", async () => {
    const controller = new win.AbortController();
    const pending = waitForPopupMessage({ closed: false } as Window, {
      expectedOrigin: "https://login.trusted.example",
      signal: controller.signal,
      context: win as unknown as Window,
    });
    controller.abort();
    await assert.rejects(pending, /中止/);
  });

  it("postToOpener 拒绝通配 targetOrigin，防止令牌广播", () => {
    // happy-dom 的 Window.opener 是只读 getter，用普通对象模拟子窗口
    const child = {
      opener: { postMessage: () => undefined },
    } as unknown as Window;
    assert.throws(
      () => postToOpener({ token: "secret" }, "*", child),
      /精确的 targetOrigin/,
    );
  });

  it("postToOpener 用精确源向 opener 投递消息", () => {
    const received: unknown[] = [];
    const fakeOpener = {
      postMessage: (msg: unknown, targetOrigin: string) =>
        received.push([msg, targetOrigin]),
    };
    const child = { opener: fakeOpener } as unknown as Window;

    assert.equal(
      postToOpener({ type: "oauth-result" }, "https://community.example", child),
      true,
    );
    assert.deepEqual(received, [
      [{ type: "oauth-result" }, "https://community.example"],
    ]);
  });

  it("postToOpener 无 opener 时返回 false", () => {
    const child = { opener: null } as unknown as Window;
    assert.equal(postToOpener({ ok: 1 }, "https://community.example", child), false);
  });
});
