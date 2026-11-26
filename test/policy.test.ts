import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  resolvePolicy,
  classifyTarget,
  type GuardPolicy,
} from "../src/shared/policy.ts";

const policy: GuardPolicy = {
  ...DEFAULT_POLICY,
  trustedPopupOrigins: ["https://login.trusted.example", "https://*.pay.example"],
};

describe("shared/policy", () => {
  it("resolvePolicy 用覆盖值合并默认策略", () => {
    const resolved = resolvePolicy({ coop: "same-origin" });
    assert.equal(resolved.coop, "same-origin");
    assert.equal(resolved.externalRel, DEFAULT_POLICY.externalRel);
    assert.deepEqual(resolvePolicy().trustedPopupOrigins, []);
  });

  it("classifyTarget 识别同源", () => {
    assert.equal(
      classifyTarget("/post/2", "https://community.example", policy),
      "same-origin",
    );
    assert.equal(
      classifyTarget("https://community.example/x", "https://community.example", policy),
      "same-origin",
    );
  });

  it("classifyTarget 识别白名单受信任源（含通配符）", () => {
    assert.equal(
      classifyTarget("https://login.trusted.example/oauth", "https://community.example", policy),
      "trusted",
    );
    assert.equal(
      classifyTarget("https://gateway.pay.example/pay", "https://community.example", policy),
      "trusted",
    );
  });

  it("classifyTarget 普通外站归类为 cross-origin", () => {
    assert.equal(
      classifyTarget("https://evil.example/phish", "https://community.example", policy),
      "cross-origin",
    );
  });

  it("非 http 协议归类为 non-http", () => {
    assert.equal(
      classifyTarget("mailto:a@b.com", "https://community.example", policy),
      "non-http",
    );
  });

  it("无法解析的目标默认拒绝（cross-origin），不抛异常", () => {
    assert.equal(
      classifyTarget("http://", "https://community.example", policy),
      "cross-origin",
    );
  });
});
