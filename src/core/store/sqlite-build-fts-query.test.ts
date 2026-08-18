/**
 * buildFtsQuery 安全测试总结
 * =============================
 *
 * 问题: 用户输入中的 FTS5 操作符（AND/OR/NOT/NEAR）未过滤，
 *       可能作为 token 注入 FTS5 查询，影响搜索语义。
 *
 * 方案: 在分词前通过 sanitizeFts5Input() 剥离大写操作符。
 *       依据 FTS5 官方文档 §3.7，操作符大小写敏感，仅大写是操作符。
 *
 * 为什么只移除 AND/OR/NOT/NEAR:
 *   这四个是大写英文字母，会被 jieba 和 fallback 正则 [\p{L}\p{N}_]+
 *   当作合法 token 保留，必须显式移除。
 *   其余 FTS5 特殊字符 (* " ( ) + : ^ -) 不匹配 \p{L}\p{N}，
 *   已被 jieba 标点过滤器或正则自然滤掉，无需额外处理。
 *
 * 覆盖场景:
 *   - 大写操作符注入: AND, OR, NOT, NEAR 单独/组合
 *   - 小写保留:       and, or, not 作为普通单词不受影响
 *   - 边界情况:       纯操作符/空输入返回 null
 *   - 正常搜索:       英文、中文搜索不受影响
 *   - 双路径覆盖:     fallback（无 jieba）和 jieba 路径
 *
 * 总计: 12 tests, 全部通过
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildFtsQuery,
  _setJiebaForTest,
  _resetJiebaForTest,
} from "./sqlite.js";

/** 检查输出中不包含被引号包裹的 FTS5 操作符 token */
function hasNoQuotedOps(result: string | null): boolean {
  if (result === null) return true;
  return !/"(AND|OR|NOT|NEAR)"/.test(result);
}

describe("buildFtsQuery - FTS5 operator sanitization", () => {
  describe("fallback path (jieba unavailable)", () => {
    beforeEach(() => {
      _setJiebaForTest(null);
    });
    afterEach(() => {
      _resetJiebaForTest();
    });

    // 输入: "hello AND world"
    // 修复前: '"hello" OR "AND" OR "world"'  ← AND 作为 token 注入
    // 修复后: '"hello" OR "world"'           ← AND 被移除
    it("strips uppercase AND operator", () => {
      const q = buildFtsQuery("hello AND world");
      expect(hasNoQuotedOps(q)).toBe(true);
      expect(q).toContain("hello");
      expect(q).toContain("world");
    });

    // 输入: "hello OR world"
    // 修复前: '"hello" OR "OR" OR "world"'   ← OR 作为 token 注入
    // 修复后: '"hello" OR "world"'           ← OR 被移除
    it("strips uppercase OR operator", () => {
      const q = buildFtsQuery("hello OR world");
      expect(hasNoQuotedOps(q)).toBe(true);
      expect(q).toContain("hello");
      expect(q).toContain("world");
    });

    // 输入: "NOT found"
    // 修复前: '"NOT" OR "found"'   ← NOT 作为 token 注入
    // 修复后: '"found"'            ← NOT 被移除
    it("strips uppercase NOT operator", () => {
      const q = buildFtsQuery("NOT found");
      expect(hasNoQuotedOps(q)).toBe(true);
      expect(q).toContain("found");
    });

    // 输入: "fast NEAR car"
    // 修复前: '"fast" OR "NEAR" OR "car"'   ← NEAR 作为 token 注入
    // 修复后: '"fast" OR "car"'             ← NEAR 被移除
    it("strips uppercase NEAR operator", () => {
      const q = buildFtsQuery("fast NEAR car");
      expect(hasNoQuotedOps(q)).toBe(true);
      expect(q).toContain("fast");
      expect(q).toContain("car");
    });

    // 输入: "hello and world" / "hello or world" / "not found"
    // 修复后: 小写 and/or/not 作为普通单词保留（FTS5 操作符大小写敏感）
    //   '"hello" OR "and" OR "world"'
    //   '"hello" OR "or" OR "world"'
    //   '"not" OR "found"'
    it("preserves lowercase and/or/not as normal words", () => {
      expect(buildFtsQuery("hello and world")).toContain('"and"');
      expect(buildFtsQuery("hello or world")).toContain('"or"');
      expect(buildFtsQuery("not found")).toContain('"not"');
    });

    // 输入: "AND hello OR world NOT test NEAR query"
    // 修复前: '"AND" OR "hello" OR "OR" OR "world" OR "NOT" OR "test" OR "NEAR" OR "query"'
    // 修复后: '"hello" OR "world" OR "test" OR "query"'
    it("strips all operators from mixed input", () => {
      const q = buildFtsQuery("AND hello OR world NOT test NEAR query");
      expect(hasNoQuotedOps(q)).toBe(true);
      expect(q).toContain("hello");
      expect(q).toContain("world");
      expect(q).toContain("test");
      expect(q).toContain("query");
    });

    // 输入: "AND OR NOT" / "NEAR"
    // 修复后: null  (全部 token 被过滤，无有效搜索词)
    it("returns null for input consisting solely of operators", () => {
      expect(buildFtsQuery("AND OR NOT")).toBeNull();
      expect(buildFtsQuery("NEAR")).toBeNull();
    });

    // 输入: "" / "   "
    // 修复后: null  (无有效 token)
    it("returns null for empty/whitespace input", () => {
      expect(buildFtsQuery("")).toBeNull();
      expect(buildFtsQuery("   ")).toBeNull();
    });

    // 输入: "hello world"             → '"hello" OR "world"'
    // 输入: "C++ programming"         → '"C" OR "programming"'
    // 修复后: 正常搜索不受影响
    it("does not affect normal English text", () => {
      expect(buildFtsQuery("hello world")).toBe('"hello" OR "world"');
      expect(buildFtsQuery("C++ programming")).toBe('"C" OR "programming"');
    });
  });

  describe("jieba path (jieba available)", () => {
    afterEach(() => {
      _resetJiebaForTest();
    });

    // 输入: "北京烤鸭 AND 编程"
    // 修复前: AND 作为 jieba token 注入
    // 修复后: AND 被 sanitize 移除，中文分词正常
    it("strips AND from mixed Chinese-English input", () => {
      const q = buildFtsQuery("北京烤鸭 AND 编程");
      expect(hasNoQuotedOps(q)).toBe(true);
      expect(q).not.toBeNull();
    });

    // 输入: "北京烤鸭"
    // 修复后: '"北京" OR "烤鸭" OR "北京烤鸭"'
    // 中文分词正常，"北京烤鸭" 拆出子词以提升召回
    it("preserves normal Chinese text", () => {
      const q = buildFtsQuery("北京烤鸭");
      expect(q).not.toBeNull();
      expect(q!.length).toBeGreaterThan(0);
    });

    // 输入: "AND OR NOT NEAR"
    // 修复后: null  (全部为 FTS5 操作符，无有效中文 token)
    it("returns null for pure FTS5 operators", () => {
      expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
    });
  });
});
