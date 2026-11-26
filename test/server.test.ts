import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSecurityHeaders,
  isCoopExempt,
  applySecurityHeaders,
} from "../src/server/headers.ts";
import {
  planRedirect,
  safeRedirectHandler,
  type MinimalRequest,
  type MinimalResponse,
} from "../src/server/redirect.ts";
import { createSecurityMiddleware } from "../src/server/middleware.ts";
import { DEFAULT_POLICY, type GuardPolicy } from "../src/shared/policy.ts";

const policy: GuardPolicy = {
  ...DEFAULT_POLICY,
  coop: "same-origin-allow-popups",
  coopExemptPathPrefixes: ["/oauth/callback"],
  allowedRedirectOrigins: ["https://docs.example.com", "https://*.partner.example"],
};

describe("server/headers", () => {
  it("默认生成 COOP 与 Referrer-Policy", () => {
    const headers = buildSecurityHeaders({ policy });
    assert.equal(
      headers["Cross-Origin-Opener-Policy"],
      "same-origin-allow-popups",
    );
    assert.equal(
      headers["Referrer-Policy"],
      "strict-origin-when-cross-origin",
    );
  });

  it("豁免路由返回 unsafe-none，让浏览器覆盖缓存的强策略", () => {
    const headers = buildSecurityHeaders({ policy, pathname: "/oauth/callback" });
    assert.equal(headers["Cross-Origin-Opener-Policy"], "unsafe-none");
  });

  it("豁免前缀按路径段匹配，前缀的字符串前缀巧合不命中", () => {
    assert.ok(isCoopExempt("/oauth/callback", policy));
    assert.ok(isCoopExempt("/oauth/callback/step2", policy));
    assert.equal(isCoopExempt("/oauth/callback-evil", policy), false);
  });

  it("same-origin 模式给出最强隔离值", () => {
    const headers = buildSecurityHeaders({
      policy: { ...policy, coop: "same-origin" },
    });
    assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin");
  });

  it("applySecurityHeaders 写入框架无关的响应对象", () => {
    const bag = new Map<string, string>();
    const res: MinimalResponse = {
      setHeader: (k, v) => void bag.set(k, v),
      statusCode: 200,
      end: () => undefined,
    };
    applySecurityHeaders(res, { policy });
    assert.equal(bag.get("Cross-Origin-Opener-Policy"), "same-origin-allow-popups");
  });
});

describe("server/redirect planRedirect", () => {
  it("同源相对路径放行", () => {
    const d = planRedirect("/post/123", "https://community.example", policy);
    assert.ok(d.allowed);
    if (d.allowed) assert.equal(d.sameOrigin, true);
  });

  it("白名单外站放行并标记为跨源", () => {
    const d = planRedirect("https://docs.example.com/guide", "https://community.example", policy);
    assert.ok(d.allowed);
    if (d.allowed) assert.equal(d.sameOrigin, false);
  });

  it("通配符白名单匹配子域", () => {
    const d = planRedirect("https://api.partner.example/v1", "https://community.example", policy);
    assert.ok(d.allowed);
  });

  it("白名单外的外站拒绝", () => {
    const d = planRedirect("https://evil.example/phish", "https://community.example", policy);
    assert.equal(d.allowed, false);
  });

  it("协议相对 URL 指向外站时按源校验", () => {
    const d = planRedirect("//evil.example/x", "https://community.example", policy);
    assert.equal(d.allowed, false);
  });

  it("javascript: 等非 http 协议拒绝", () => {
    assert.equal(
      planRedirect("javascript:alert(1)", "https://community.example", policy).allowed,
      false,
    );
    assert.equal(
      planRedirect("data:text/html,x", "https://community.example", policy).allowed,
      false,
    );
  });

  it("包含 CRLF/控制字符的目标拒绝（防响应头注入）", () => {
    const d = planRedirect(
      "https://docs.example.com/%0d%0aSet-Cookie:x=1",
      "https://community.example",
      policy,
    );
    // 编码后的 %0d%0a 是普通字符，应可解析；真正的裸 CR/LF 才拒绝
    assert.ok(d.allowed);
    const raw = planRedirect("/a\r\nSet-Cookie: x=1", "https://community.example", policy);
    assert.equal(raw.allowed, false);
  });

  it("空目标拒绝", () => {
    assert.equal(planRedirect("", "https://community.example", policy).allowed, false);
  });
});

describe("server/redirect safeRedirectHandler", () => {
  function fakeReqRes(url: string) {
    const headers: Record<string, string> = {};
    const req: MinimalRequest = {
      url,
      headers: { host: "community.example" },
      socket: { encrypted: true },
    };
    const res: MinimalResponse & { location?: string; referrer?: string } = {
      statusCode: 200,
      setHeader(k, v) {
        if (k === "Location") this.location = v;
        if (k === "Referrer-Policy") this.referrer = v;
      },
      end() {},
    };
    return { req, res, headers };
  }

  it("合法外站跳转 302 并收紧 Referrer-Policy", () => {
    const handler = safeRedirectHandler({ policy });
    const { req, res } = fakeReqRes("/redirect?to=https://docs.example.com/g");
    handler(req, res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.location, "https://docs.example.com/g");
    assert.equal(res.referrer, "no-referrer");
  });

  it("非法跳转回退到站内首页，不回显错误细节", () => {
    const handler = safeRedirectHandler({ policy });
    const { req, res } = fakeReqRes("/redirect?to=https://evil.example/x");
    const { decision } = handler(req, res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.location, "/");
    assert.equal(decision.allowed, false);
  });

  it("同源跳转保留默认 Referrer-Policy", () => {
    const handler = safeRedirectHandler({ policy });
    const { req, res } = fakeReqRes("/redirect?to=/post/1");
    handler(req, res);
    assert.equal(res.location, `${new URL(req.url, "https://community.example").origin}/post/1`);
    assert.equal(res.referrer, policy.referrerPolicy);
  });
});

describe("server/middleware", () => {
  it("非跳转路由注入安全头并返回 false 放行", () => {
    const mw = createSecurityMiddleware({ policy });
    const bag = new Map<string, string>();
    const req = {
      url: "/feed",
      headers: { host: "community.example" },
      socket: { encrypted: true },
    } as unknown as import("node:http").IncomingMessage;
    const res = {
      setHeader: (k: string, v: string) => void bag.set(k, v),
      end: () => undefined,
      statusCode: 200,
    } as unknown as import("node:http").ServerResponse;

    const handled = mw(req, res);
    assert.equal(handled, false);
    assert.equal(bag.get("Cross-Origin-Opener-Policy"), "same-origin-allow-popups");
    assert.equal(bag.get("X-Content-Type-Options"), "nosniff");
  });

  it("/redirect 路由被中间件终结并返回 true", () => {
    const mw = createSecurityMiddleware({ policy });
    const req = {
      url: "/redirect?to=https://evil.example/x",
      headers: { host: "community.example" },
      socket: { encrypted: true },
    } as unknown as import("node:http").IncomingMessage;
    const headerBag = new Map<string, string>();
    const res = {
      statusCode: 200,
      setHeader(k: string, v: string) {
        headerBag.set(k, v);
      },
      end() {},
    } as unknown as import("node:http").ServerResponse;

    const handled = mw(req, res);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 302);
    assert.equal(headerBag.get("Cross-Origin-Opener-Policy"), "same-origin-allow-popups");
  });
});
