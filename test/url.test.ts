import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseUrl,
  safeOrigin,
  originMatches,
  isOriginAllowed,
} from "../src/shared/url.ts";

describe("shared/url", () => {
  it("宽松解析失败返回 null 而不是抛异常", () => {
    assert.equal(parseUrl("not a url"), null);
    assert.equal(parseUrl("http://"), null);
  });

  it("safeOrigin 只认可 http/https", () => {
    assert.equal(safeOrigin("https://a.example/path"), "https://a.example");
    assert.equal(safeOrigin("http://a.example:8080/x"), "http://a.example:8080");
    assert.equal(safeOrigin("javascript:alert(1)"), null);
    assert.equal(safeOrigin("data:text/html,x"), null);
    assert.equal(safeOrigin("mailto:a@b.com"), null);
  });

  it("精确源匹配比较协议、主机与端口", () => {
    assert.ok(originMatches("https://pay.example.com", "https://pay.example.com"));
    assert.ok(originMatches("http://pay.example.com:8080", "http://pay.example.com:8080"));
    assert.equal(originMatches("http://pay.example.com", "https://pay.example.com"), false);
    assert.equal(originMatches("https://pay.example.com:9000", "https://pay.example.com"), false);
    assert.equal(originMatches("https://notpay.example.com", "https://pay.example.com"), false);
  });

  it("通配符只匹配子域，不匹配裸域", () => {
    const pattern = "https://*.example.com";
    assert.ok(originMatches("https://a.example.com", pattern));
    assert.ok(originMatches("https://a.b.example.com", pattern));
    assert.equal(originMatches("https://example.com", pattern), false);
    assert.equal(originMatches("https://evilexample.com", pattern), false);
  });

  it("带路径的白名单条目视为非法配置，不生效", () => {
    assert.equal(
      originMatches("https://pay.example.com", "https://pay.example.com/callback"),
      false,
    );
  });

  it("通配符 * 匹配所有源", () => {
    assert.ok(originMatches("https://anything.example", "*"));
  });

  it("isOriginAllowed 对整个名单求值", () => {
    const list = ["https://a.example.com", "https://*.trusted.example"];
    assert.ok(isOriginAllowed("https://a.example.com", list));
    assert.ok(isOriginAllowed("https://api.trusted.example", list));
    assert.equal(isOriginAllowed("https://evil.example", list), false);
  });

  it("默认端口规范化后仍可匹配", () => {
    assert.ok(originMatches("https://a.example.com:443", "https://a.example.com"));
  });
});
