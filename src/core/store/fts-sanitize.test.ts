import { describe, expect, it, afterEach } from "vitest";

import {
  buildFtsQuery,
  _setJiebaForTest,
  _resetJiebaForTest,
} from "./sqlite.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Mock jieba instance that returns predefined tokens.
 * Simulates jieba.cutForSearch() behavior for testing.
 */
function createMockJieba(tokens: string[]) {
  return {
    cutForSearch: (_text: string, _hmm: boolean) => tokens,
  };
}

/**
 * Mock jieba that splits by whitespace (simple tokenizer for testing).
 */
function createWhitespaceJieba() {
  return {
    cutForSearch: (text: string, _hmm: boolean) => text.split(/\s+/).filter(Boolean),
  };
}

// ─── Test Suite ────────────────────────────────────────────────────────────

describe("FTS5 injection sanitization", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 基础阶段：对 FTS5 特殊字符进行转义，普通用户搜索不受影响
  // ══════════════════════════════════════════════════════════════════════

  describe("基础转义 - 特殊字符", () => {
    it("移除双引号", () => {
      _setJiebaForTest(createMockJieba(['test"query']));
      const result = buildFtsQuery("test\"query");
      expect(result).toBe('"testquery"');
    });

    it("移除单引号", () => {
      _setJiebaForTest(createMockJieba(["it's"]));
      const result = buildFtsQuery("it's");
      expect(result).toBe('"its"');
    });

    it("移除括号", () => {
      _setJiebaForTest(createMockJieba(["foo(bar)"]));
      const result = buildFtsQuery("foo(bar)");
      expect(result).toBe('"foobar"');
    });

    it("移除星号（前缀通配符）", () => {
      _setJiebaForTest(createMockJieba(["test*"]));
      const result = buildFtsQuery("test*");
      expect(result).toBe('"test"');
    });

    it("移除混合特殊字符", () => {
      _setJiebaForTest(createMockJieba(['"test"(query)*']));
      const result = buildFtsQuery('"test"(query)*');
      expect(result).toBe('"testquery"');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 进阶阶段：覆盖所有 FTS5 操作符和边界情况
  // ═══════════════════════════════════════════════════════════════════════

  describe("操作符注入防护", () => {
    it("过滤纯 AND 关键字", () => {
      _setJiebaForTest(createMockJieba(["foo", "AND", "bar"]));
      const result = buildFtsQuery("foo AND bar");
      expect(result).toBe('"foo" OR "bar"');
    });

    it("过滤纯 OR 关键字", () => {
      _setJiebaForTest(createMockJieba(["foo", "OR", "bar"]));
      const result = buildFtsQuery("foo OR bar");
      expect(result).toBe('"foo" OR "bar"');
    });

    it("过滤纯 NOT 关键字", () => {
      _setJiebaForTest(createMockJieba(["foo", "NOT", "bar"]));
      const result = buildFtsQuery("foo NOT bar");
      expect(result).toBe('"foo" OR "bar"');
    });

    it("过滤纯 NEAR 关键字", () => {
      _setJiebaForTest(createMockJieba(["foo", "NEAR", "bar"]));
      const result = buildFtsQuery("foo NEAR bar");
      expect(result).toBe('"foo" OR "bar"');
    });

    it("大小写不敏感过滤操作符", () => {
      _setJiebaForTest(createMockJieba(["and", "And", "aNd"]));
      expect(buildFtsQuery("and")).toBeNull();
      expect(buildFtsQuery("And")).toBeNull();
      expect(buildFtsQuery("aNd")).toBeNull();
    });

    it("保留包含操作符字母的正常词", () => {
      _setJiebaForTest(createMockJieba(["BAND", "ORDER", "NOTIFY", "NEAREST"]));
      const result = buildFtsQuery("BAND ORDER NOTIFY NEAREST");
      expect(result).toBe('"BAND" OR "ORDER" OR "NOTIFY" OR "NEAREST"');
    });
  });

  describe("边界情况", () => {
    it("空字符串返回 null", () => {
      _setJiebaForTest(createMockJieba([]));
      expect(buildFtsQuery("")).toBeNull();
    });

    it("纯特殊字符返回 null", () => {
      _setJiebaForTest(createMockJieba(['"', "'", "(", ")", "*"]));
      expect(buildFtsQuery('"\'()*')).toBeNull();
    });

    it("纯操作符关键字返回 null", () => {
      _setJiebaForTest(createMockJieba(["AND", "OR"]));
      expect(buildFtsQuery("AND OR")).toBeNull();
    });

    it("只有空格返回 null", () => {
      _setJiebaForTest(createMockJieba([]));
      expect(buildFtsQuery("   ")).toBeNull();
    });

    it("特殊字符和操作符混合后仍有有效词", () => {
      _setJiebaForTest(createMockJieba(['"AND"', "test", "*", "NOT"]));
      const result = buildFtsQuery('"AND" test * NOT');
      expect(result).toBe('"test"');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 深入阶段：对比转义前后 recall 效果
  // ═══════════════════════════════════════════════════════════════════════

  describe("recall 效果验证", () => {
    it("正常中文搜索不受影响", () => {
      _setJiebaForTest(createMockJieba(["用户", "喜欢", "编程"]));
      const result = buildFtsQuery("用户喜欢编程");
      expect(result).toBe('"用户" OR "喜欢" OR "编程"');
    });

    it("正常英文搜索不受影响", () => {
      _setJiebaForTest(createMockJieba(["TypeScript", "React", "Vue"]));
      const result = buildFtsQuery("TypeScript React Vue");
      expect(result).toBe('"TypeScript" OR "React" OR "Vue"');
    });

    it("中英文混合搜索不受影响", () => {
      _setJiebaForTest(createMockJieba(["用户", "API", "接口"]));
      const result = buildFtsQuery("用户 API 接口");
      expect(result).toBe('"用户" OR "API" OR "接口"');
    });

    it("带标点的正常查询正确处理", () => {
      _setJiebaForTest(createMockJieba(["今天", "天气", "怎么样"]));
      const result = buildFtsQuery("今天天气怎么样？");
      expect(result).toBe('"今天" OR "天气" OR "怎么样"');
    });

    it("长查询多 token 正确处理", () => {
      const tokens = ["北京", "烤鸭", "哪里", "好吃", "推荐"];
      _setJiebaForTest(createMockJieba(tokens));
      const result = buildFtsQuery("北京烤鸭哪里好吃推荐");
      expect(result).toBe('"北京" OR "烤鸭" OR "哪里" OR "好吃" OR "推荐"');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 拓展阶段：白名单方案验证
  // ═══════════════════════════════════════════════════════════════════════

  describe("白名单方案安全性", () => {
    it("只保留 Unicode 字母、数字、下划线", () => {
      _setJiebaForTest(createMockJieba(["hello_world", "test123", "中文"]));
      const result = buildFtsQuery("hello_world test123 中文");
      expect(result).toBe('"hello_world" OR "test123" OR "中文"');
    });

    it("拒绝所有非白名单字符", () => {
      const malicious = '"; DROP TABLE--';
      _setJiebaForTest(createMockJieba([malicious]));
      const result = buildFtsQuery(malicious);
      // 只保留字母：DROP TABLE
      expect(result).toBe('"DROPTABLE"');
    });

    it("复杂注入尝试被完全中和", () => {
      const injection = 'test" OR "1"="1';
      _setJiebaForTest(createMockJieba([injection]));
      const result = buildFtsQuery(injection);
      expect(result).toBe('"testOR11"');
    });

    it("FTS5 语法结构被破坏", () => {
      // 当 jieba 把整个字符串作为一个 token 时，特殊字符被移除后变成普通词
      const ftsSyntax = 'NEAR("foo", "bar", 5)';
      _setJiebaForTest(createMockJieba([ftsSyntax]));
      const result = buildFtsQuery(ftsSyntax);
      // 特殊字符被移除 → "NEARfoobar5"，不是纯关键字 NEAR，作为普通词保留
      expect(result).toBe('"NEARfoobar5"');
    });

    it("FTS5 语法结构被破坏 - 分词后操作符被过滤", () => {
      // 当 jieba 正确分词后，NEAR 作为独立 token 会被过滤
      _setJiebaForTest(createMockJieba(["NEAR", "foo", "bar", "5"]));
      const result = buildFtsQuery('NEAR("foo", "bar", 5)');
      // NEAR 被过滤，只保留 foo bar 5
      expect(result).toBe('"foo" OR "bar" OR "5"');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Fallback 路径测试（无 jieba）
  // ═══════════════════════════════════════════════════════════════════════

  describe("Fallback 路径（无 jieba）", () => {
    it("fallback 正则已排除大部分特殊字符", () => {
      _setJiebaForTest(null); // 强制 fallback
      const result = buildFtsQuery('test"query');
      // 正则 /[\p{L}\p{N}_]+/gu 会分成 ["test", "query"]
      expect(result).toBe('"test" OR "query"');
    });

    it("fallback 路径仍过滤操作符关键字", () => {
      _setJiebaForTest(null);
      const result = buildFtsQuery("foo AND bar");
      // 正则分成 ["foo", "AND", "bar"]，AND 被 sanitize 过滤
      expect(result).toBe('"foo" OR "bar"');
    });

    it("fallback 路径处理特殊字符", () => {
      _setJiebaForTest(null);
      const result = buildFtsQuery("test*(query)");
      expect(result).toBe('"test" OR "query"');
    });
  });
});
