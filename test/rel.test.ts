import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitRel,
  mergeRelTokens,
  removeRelTokens,
  hasRelToken,
} from "../src/shared/rel.ts";

describe("shared/rel", () => {
  it("分词去重并转小写", () => {
    assert.deepEqual(splitRel("noopener NOOPENER  noreferrer "), [
      "noopener",
      "noreferrer",
    ]);
    assert.deepEqual(splitRel(null), []);
    assert.deepEqual(splitRel(""), []);
  });

  it("mergeRelTokens 保留原顺序并追加缺失 token", () => {
    assert.equal(
      mergeRelTokens("ugc noopener", ["noopener", "noreferrer"]),
      "ugc noopener noreferrer",
    );
    assert.equal(mergeRelTokens(null, ["noopener"]), "noopener");
  });

  it("removeRelTokens 精确剔除", () => {
    assert.equal(
      removeRelTokens("noopener noreferrer ugc", ["noopener"]),
      "noreferrer ugc",
    );
    assert.equal(removeRelTokens("noopener", ["noopener", "noreferrer"]), "");
  });

  it("hasRelToken 大小写不敏感", () => {
    assert.ok(hasRelToken("NOOPENER", "noopener"));
    assert.equal(hasRelToken("noreferrer", "noopener"), false);
  });
});
