import { describe, expect, it } from "vitest";
import { buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  it("handles basic keyword searches", () => {
    const query = buildFtsQuery("测试 项目");
    expect(query).toBe('"测试" OR "项目"');
  });

  it("filters out FTS5 special punctuation syntax", () => {
    // These characters should be stripped/replaced before FTS tokenization
    const query = buildFtsQuery("测试 \" ' ( ) * - 崩溃");
    // jieba will segment it, but the quotes and special chars shouldn't be passed verbatim
    // It should end up like "测试" OR "崩溃"
    expect(query).toBe('"测试" OR "崩溃"');
  });

  it("downcases FTS5 boolean operators so they are treated as literal search terms", () => {
    // "AND", "OR", "NOT", "NEAR" are FTS5 keywords and should be downcased to "and", "or", "not", "near"
    const query = buildFtsQuery("数据库 AND 崩溃 OR 测试 NOT 正常 NEAR 1");
    // Because jieba tokenizer splits these and we downcase them, they become regular words.
    // NOTE: '1' is kept because it's a number.
    expect(query).toBe('"数据" OR "据库" OR "数据库" OR "and" OR "崩溃" OR "or" OR "测试" OR "not" OR "正常" OR "near" OR "1"');
  });

  it("handles empty or purely special character inputs", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("\" ' ( ) * -")).toBeNull();
  });
});
