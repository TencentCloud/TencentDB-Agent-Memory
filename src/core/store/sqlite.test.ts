import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
  buildFtsQuery,
  sanitizeFts5Input,
  bm25RankToScore,
  _setJiebaForTest,
  _resetJiebaForTest,
} from "./sqlite.js";

// ============================
// Suite A: sanitizeFts5Input 纯函数单测
// ============================

describe("sanitizeFts5Input", () => {
  it("A1: 正常英文文本不变", () => {
    expect(sanitizeFts5Input("hello world")).toBe("hello world");
  });

  it("A2: 正常中文文本不变", () => {
    expect(sanitizeFts5Input("用户喜欢编程")).toBe("用户喜欢编程");
  });

  it("A3: 大小写混合 OR 剥离", () => {
    expect(sanitizeFts5Input("hello Or world")).toBe("hello world");
  });

  it("A4: 全大写 AND 作为独立单词剥离", () => {
    expect(sanitizeFts5Input("cats AND dogs")).toBe("cats dogs");
  });

  it("A5: 全大写 OR 作为独立单词剥离", () => {
    expect(sanitizeFts5Input("tea OR coffee")).toBe("tea coffee");
  });

  it("A6: 全小写 not 作为独立单词剥离", () => {
    expect(sanitizeFts5Input("this not that")).toBe("this that");
  });

  it("A7: 句首 NOT 剥离 + 空白修剪", () => {
    expect(sanitizeFts5Input("NOT hello")).toBe("hello");
  });

  it("A8: NEAR（大小写混合）剥离", () => {
    expect(sanitizeFts5Input("word1 NEAR word2")).toBe("word1 word2");
  });

  it("A9: 小写 near 剥离（大小写不敏感）", () => {
    expect(sanitizeFts5Input("a near b")).toBe("a b");
  });

  it("A10: ANDROID 不受影响——\b 边界防止误匹配", () => {
    expect(sanitizeFts5Input("ANDROID studio")).toBe("ANDROID studio");
  });

  it("A11: NORTH NOT affected — \bNOT\b does not match inside NORTH", () => {
    expect(sanitizeFts5Input("NORTH south")).toBe("NORTH south");
  });

  it("A12: honorable 不受影响——嵌入的 'or' 不在单词边界", () => {
    expect(sanitizeFts5Input("honorable mention")).toBe("honorable mention");
  });

  it("A13: 连续操作符全部移除 + 空白压缩", () => {
    expect(sanitizeFts5Input("AND OR NOT hello")).toBe("hello");
  });

  it("A14: * 通配符移除", () => {
    expect(sanitizeFts5Input("hello* world")).toBe("hello world");
  });

  it("A15: 括号 ( ) 移除", () => {
    expect(sanitizeFts5Input("(hello world)")).toBe("hello world");
  });

  it("A16: ASCII 双引号移除", () => {
    expect(sanitizeFts5Input('"hello world"')).toBe("hello world");
  });

  it("A17: ^ 列前缀字符移除", () => {
    expect(sanitizeFts5Input("^hello")).toBe("hello");
  });

  it("A18: { } 列过滤大括号移除，冒号保留", () => {
    expect(sanitizeFts5Input("{title}: hello")).toBe("title : hello");
  });

  it("A19: 全部特殊字符 + 保留字移除，空白压缩", () => {
    expect(sanitizeFts5Input('"hello*" AND (world) ^test {col}')).toBe("hello world test col");
  });

  it("A20: 仅操作符/特殊字符 → 空字符串", () => {
    expect(sanitizeFts5Input('AND OR * ( ) " ^ { }')).toBe("");
  });

  it("A21: 连续空白压缩为单空格", () => {
    expect(sanitizeFts5Input("hello    world")).toBe("hello world");
  });

  it("A22: 首尾空白修剪", () => {
    expect(sanitizeFts5Input("  hello world  ")).toBe("hello world");
  });

  it("A23: CJK punctuation — NFKC normalises fullwidth ,! to ASCII (documented)", () => {
    // NFKC: U+FF0C → U+002C, U+FF01 → U+0021 — fullwidth→ASCII is correct
    expect(sanitizeFts5Input("你好，世界！")).toBe("你好,世界!");
  });

  it("A24: 数字保留", () => {
    expect(sanitizeFts5Input("2024 report v2")).toBe("2024 report v2");
  });

  it("A25: 下划线保留（非 FTS5 特殊字符）", () => {
    expect(sanitizeFts5Input("hello_world func_name")).toBe("hello_world func_name");
  });

  it("A26: Unicode 弯引号保留——非 ASCII 引号", () => {
    expect(sanitizeFts5Input("“hello” world")).toBe("“hello” world");
  });

  // ── NFKC normalisation ──────────────────────────

  it("A27: full-width AND (U+FF21 U+FF2E U+FF24) normalised and stripped", () => {
    // ＡＮＤ → NFKC → AND → stripped
    expect(sanitizeFts5Input("hello ＡＮＤ world")).toBe("hello world");
  });

  it("A28: full-width OR normalised and stripped", () => {
    expect(sanitizeFts5Input("tea ＯＲ coffee")).toBe("tea coffee");
  });

  it("A29: full-width NOT normalised and stripped", () => {
    expect(sanitizeFts5Input("ＮＯＴ hello")).toBe("hello");
  });

  it("A30: full-width special chars normalised — ＂ (full-width quote) → \" → stripped", () => {
    // U+FF02 (full-width quotation mark) → NFKC → " → stripped
    expect(sanitizeFts5Input("＂hello＂ world")).toBe("hello world");
  });

  it("A31: full-width parentheses normalised and stripped", () => {
    // U+FF08 U+FF09 → NFKC → ( ) → stripped
    expect(sanitizeFts5Input("（hello world）")).toBe("hello world");
  });

  // ── Column-filter stripping ──────────────────────

  it("A32: content: prefix stripped", () => {
    expect(sanitizeFts5Input("content:hello world")).toBe("hello world");
  });

  it("A33: -content: (negated column filter) stripped; content after : survives", () => {
    expect(sanitizeFts5Input("-content:secret hello")).toBe("secret hello");
  });

  it("A34: message: prefix stripped; content after : survives", () => {
    expect(sanitizeFts5Input("message:greeting hello")).toBe("greeting hello");
  });

  it("A35: session: / actor: / topic: prefixes stripped; values survive", () => {
    expect(sanitizeFts5Input("session:abc actor:xyz topic:q hello")).toBe(
      "abc xyz q hello",
    );
  });

  it("A36: content: stripped whether or not space before colon", () => {
    // \s* in the regex matches optional whitespace before the colon
    expect(sanitizeFts5Input("content:hello")).toBe("hello");
    expect(sanitizeFts5Input("content :hello")).toBe("hello");
  });

  it("A37: file: / host: / user: / role: / tag: prefixes stripped", () => {
    expect(sanitizeFts5Input("file:x host:y user:z role:a tag:b hello")).toBe(
      "x y z a b hello",
    );
  });

  it("A38: column filter inside longer text", () => {
    expect(sanitizeFts5Input("search -content:secret AND hello world")).toBe(
      "search secret hello world",
    );
  });
});

// ============================
// Suite B：buildFtsQuery — jieba 路径
// ============================

describe("buildFtsQuery (jieba)", () => {
  it("B1: 简单中文——返回非 null 的 OR-join 加引号 token", () => {
    const result = buildFtsQuery("用户喜欢编程");
    expect(result).not.toBeNull();
    // Output should contain "OR" join and quoted tokens
    expect(result!).toMatch(/^".+"( OR ".+")*$/);
  });

  it("B2: 中文含 OR 注入——token 不含 OR", () => {
    const result = buildFtsQuery("用户 OR 编程");
    expect(result).not.toBeNull();
    // The "OR" keyword should have been stripped; output tokens are all real words
    const tokens = result!.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("OR");
  });

  it("B3: 中英混合——两者都保留，AND 剥离", () => {
    const result = buildFtsQuery("用户喜欢 TypeScript AND Python");
    expect(result).not.toBeNull();
    const output = result!;
    // Should contain Chinese and English tokens
    expect(output).toContain("TypeScript");
    expect(output).toContain("Python");
    // AND should not appear as a standalone token
    const tokens = output.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("AND");
  });

  it("B4: 查询中 * 通配符移除", () => {
    const result = buildFtsQuery("搜索*所有*项目");
    expect(result).not.toBeNull();
    // No bare * should remain in the output
    expect(result!).not.toMatch(/(?<!")\*(?!")/);
  });

  it("B5: 查询中 ASCII 双引号移除", () => {
    const result = buildFtsQuery('"你好" 世界');
    expect(result).not.toBeNull();
    // Each quoted token should not contain internal ASCII double-quotes
    const tokens = result!.split(" OR ");
    for (const t of tokens) {
      const inner = t.slice(1, -1); // strip surrounding quotes
      expect(inner).not.toContain('"');
    }
  });

  it("B6: 仅操作符 → null（空结果保护）", () => {
    expect(buildFtsQuery("AND OR NOT")).toBeNull();
  });

  it("B7: 仅特殊字符 → null", () => {
    expect(buildFtsQuery('( ) * "')).toBeNull();
  });

  it("B8: 仅停用词输入 → null", () => {
    // "我的一个" are all ZH_STOP_WORDS entries
    expect(buildFtsQuery("我的一个")).toBeNull();
  });

  it("B9: 长中文句子 → 非 null 多个 token", () => {
    const result = buildFtsQuery("人工智能正在改变世界的方式是前所未有的");
    expect(result).not.toBeNull();
    // Should produce multiple tokens
    const parts = result!.split(" OR ");
    expect(parts.length).toBeGreaterThan(1);
  });

  it("B10: OR-join 格式——token 用双引号包裹并 OR 连接", () => {
    const result = buildFtsQuery("hello world");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/^".+"( OR ".+")*$/);
  });

  it("B11: 每个 token 内部 ASCII 双引号被剥离", () => {
    const result = buildFtsQuery('用户说 "你好"');
    expect(result).not.toBeNull();
    // The tokens are FTS5 phrase terms: "用户说" OR "你好"
    // Strip the outer FTS5 phrase quotes and check the inner content
    const tokens = result!.split(" OR ").map((t) => t.slice(1, -1));
    for (const t of tokens) {
      expect(t).not.toContain('"');
    }
  });

  it("B12: 去重——重复 token 仅出现一次", () => {
    const result = buildFtsQuery("hello hello world");
    expect(result).not.toBeNull();
    const tokens = result!.split(" OR ");
    const helloTokens = tokens.filter((t) => t === '"hello"');
    expect(helloTokens.length).toBe(1);
  });

  it("B13: JSON 特殊字符不污染输出", () => {
    const result = buildFtsQuery('{"key": "value"}');
    expect(result).not.toBeNull();
    // Should not contain raw { } "
    expect(result!).not.toContain("{");
    expect(result!).not.toContain("}");
    // All double-quotes in output are the FTS5 phrase delimiters
    const innerTokens = result!.split(" OR ").map((t) => t.slice(1, -1));
    for (const t of innerTokens) {
      expect(t).not.toContain('"');
    }
  });
});

// ============================
// Suite C：buildFtsQuery — fallback 路径
// ============================

describe("buildFtsQuery (fallback — no jieba)", () => {
  beforeAll(() => {
    _setJiebaForTest(null);
  });

  afterAll(() => {
    _resetJiebaForTest();
  });

  it("C1: 简单英文——正则正确提取单词", () => {
    const result = buildFtsQuery("hello world");
    expect(result).toBe('"hello" OR "world"');
  });

  it("C2: OR 被 sanitize 剥离，正则提取剩余单词", () => {
    const result = buildFtsQuery("cats OR dogs");
    expect(result).toBe('"cats" OR "dogs"');
  });

  it("C3: 句首 NOT 剥离", () => {
    const result = buildFtsQuery("NOT hello");
    expect(result).toBe('"hello"');
  });

  it("C4: NEAR 移除", () => {
    const result = buildFtsQuery("word1 NEAR word2");
    expect(result).toBe('"word1" OR "word2"');
  });

  it("C5: 所有特殊字符移除", () => {
    const result = buildFtsQuery("hello* AND (world)");
    expect(result).toBe('"hello" OR "world"');
  });

  it("C6: 大小写混合 And 移除", () => {
    const result = buildFtsQuery("Hello And World");
    expect(result).toBe('"Hello" OR "World"');
  });

  it("C7: 纯操作符 → null", () => {
    expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
  });

  it("C8: 中文无 jieba——CJK 字符形成连续 token", () => {
    const result = buildFtsQuery("用户喜欢编程");
    expect(result).toBe('"用户喜欢编程"');
  });

  it("C9: 数字+字母——句点在 fallback 正则中分割 token", () => {
    const result = buildFtsQuery("v2.0 release 2024");
    expect(result).toBe('"v2" OR "0" OR "release" OR "2024"');
  });

  it("C10: 下划线在 \p{L}\p{N}_ 正则中保留", () => {
    const result = buildFtsQuery("hello_world func");
    expect(result).toBe('"hello_world" OR "func"');
  });
});

// ============================
// Suite D：回归测试
// ============================

describe("buildFtsQuery 回归测试", () => {
  it("D1: jieba cutForSearch 子词拆分不变", () => {
    // "北京烤鸭" → jieba produces ["北京", "烤鸭", "北京烤鸭"]
    // One of these sub-words should appear in the output
    const result = buildFtsQuery("北京烤鸭很好吃");
    expect(result).not.toBeNull();
    // At minimum the compound word or its sub-words should be present
    const hasBeiJing = result!.includes("北京");
    const hasKaoYa = result!.includes("烤鸭");
    expect(hasBeiJing || hasKaoYa).toBe(true);
  });

  it("D2: jieba 按空白拆分英文", () => {
    const result = buildFtsQuery("machine learning");
    expect(result).not.toBeNull();
    expect(result!).toContain("machine");
    expect(result!).toContain("learning");
  });

  it("D3: 纯空白输入 → null", () => {
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("D4: 空字符串 → null", () => {
    expect(buildFtsQuery("")).toBeNull();
  });

  it("D5: jieba 停用词过滤", () => {
    // "的了在" are all in ZH_STOP_WORDS
    expect(buildFtsQuery("的了在")).toBeNull();
  });

  it("D6: 纯标点被 \p{L}\p{N} 过滤 → null", () => {
    expect(buildFtsQuery("!!!")).toBeNull();
  });

  it("D7: Unicode 字母（café, résumé）保留在输出中", () => {
    // jieba may segment accented Latin text into sub-tokens
    // (e.g. "café" → "caf" + "é"), which is expected behavior.
    // The key regression check: accented chars survive sanitization
    // and appear somewhere in the output tokens.
    const result = buildFtsQuery("café résumé");
    expect(result).not.toBeNull();
    // All the base characters should appear across the output tokens
    expect(result!).toContain("caf");
    expect(result!).toContain("é");
    expect(result!).toContain("sum");
  });

  it("D8: bm25RankToScore 辅助函数——rank=-5 ≈ 0.833", () => {
    const score = bm25RankToScore(-5);
    expect(score).toBeCloseTo(0.833, 1);
  });
});

// ============================
// Suite E：安全攻击向量测试
// ============================

describe("buildFtsQuery 安全测试", () => {
  it('E1: 引号逃逸尝试——输出中无裸 OR', () => {
    const result = buildFtsQuery('" OR "1"="1');
    // May be null (all stripped) or a safe query — either is acceptable
    if (result !== null) {
      // If there is output, it must NOT contain unquoted OR/NOT/AND
      const unquoted = result.replace(/" OR "/g, " | "); // hide the join ORs
      expect(unquoted).not.toMatch(/\b(AND|OR|NOT|NEAR)\b/i);
    }
  });

  it("E2: 括号注入——无括号和裸 OR", () => {
    const result = buildFtsQuery(") OR (1) OR (");
    // Sanitize strips ( ) and OR; "1" survives as a token
    if (result !== null) {
      expect(result).not.toContain("(");
      expect(result).not.toContain(")");
    }
  });

  it("E3: 操作符叠加——仅实词保留", () => {
    const result = buildFtsQuery("AND AND AND hello OR OR OR world");
    expect(result).not.toBeNull();
    // Only the real tokens remain
    const tokens = result!.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("AND");
    expect(tokens).not.toContain("OR");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
  });

  it("E4: NEAR 带参数——NEAR 剥离", () => {
    const result = buildFtsQuery("hello NEAR(5) world");
    expect(result).not.toBeNull();
    // NEAR is stripped, ( ) are stripped, 5 as a digit token remains
    // but that's harmless (literal phrase search for "5")
    expect(result!).not.toMatch(/\bNEAR\b/i);
    expect(result!).not.toContain("(");
    expect(result!).not.toContain(")");
  });

  it("E5: * 前缀通配尝试——* 移除", () => {
    const result = buildFtsQuery("secret* password*");
    expect(result).not.toBeNull();
    expect(result!).not.toContain("*");
  });

  it("E6: ^ 列名尝试——^ 移除", () => {
    const result = buildFtsQuery("^title: hello");
    expect(result).not.toBeNull();
    expect(result!).not.toContain("^");
  });

  it("E7: 大括号逃逸——大括号和 AND 全部移除", () => {
    const result = buildFtsQuery("hello} {AND world");
    expect(result).not.toBeNull();
    expect(result!).not.toContain("{");
    expect(result!).not.toContain("}");
    expect(result!).toMatch(/hello.*world/);
  });

  it("E8: 大量操作符+一个实词 → 单个 token 保留", () => {
    const result = buildFtsQuery("OR OR OR hi");
    expect(result).toBe('"hi"');
  });

  it("E9: 核心安全断言——输出中仅硬编码 OR，无其他裸操作符", () => {
    // ... (same as before)
    const inputs = [
      "hello AND world",
      "NOT test",
      "NEAR injection",
      '" OR "1"="1',
      "AND OR NOT hello",
      "hello* AND (world) NOT ^test NEAR{col}",
    ];
    for (const input of inputs) {
      const result = buildFtsQuery(input);
      if (result !== null) {
        const withoutJoins = result.replace(/" OR "/g, " | ");
        expect(withoutJoins).not.toMatch(/\b(AND|OR|NOT|NEAR)\b/i);
      }
    }
  });

  // ── NFKC bypass attempts ────────────────────────

  it("E10: 全宽操作符注入——ＡＮＤ 归一化并中性化", () => {
    const result = buildFtsQuery("hello ＡＮＤ world");
    // Full-width AND → NFKC → AND → stripped
    expect(result).not.toBeNull();
    expect(result!).not.toMatch(/\bAND\b/i);
    expect(result!).toContain("hello");
    expect(result!).toContain("world");
  });

  it("E11: 全宽引号注入——＂ 中性化", () => {
    const result = buildFtsQuery('＂ OR ＂1＂="1');
    // Full-width quotes → NFKC → " → stripped; OR → stripped
    if (result !== null) {
      const withoutJoins = result.replace(/" OR "/g, " | ");
      expect(withoutJoins).not.toMatch(/\b(AND|OR|NOT|NEAR)\b/i);
    }
  });

  it("E12: 列过滤注入——content: 剥离，实词保留", () => {
    const result = buildFtsQuery("-content:secret search");
    expect(result).not.toBeNull();
    // -content: → column filter stripped; "secret" + "search" both survive
    // as literal phrase terms (the column filter syntax is neutralised)
    const tokens = result!.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("-content");
    expect(tokens).toContain("secret");
    expect(tokens).toContain("search");
  });
});

// ============================
// Suite F：模糊/对抗边界测试
// ============================

describe("buildFtsQuery 模糊与对抗边界", () => {
  // ── CJK boundary behavior ──────────────────────
  // JS \b is defined in terms of \w = [A-Za-z0-9_], so CJK characters
  // (non-\w) create word boundaries on both sides of ASCII words.
  // This means "你AND你" WILL strip AND.  Documented as acceptable:
  // real users don't sprinkle standalone AND/OR/NOT between CJK chars.

  it("F1: \\b strips AND between CJK chars (documented limitation)", () => {
    // "搜索" and "记忆" are NOT stop words, so they survive jieba filtering.
    // AND is surrounded by CJK (non-\w) chars → \b on both sides → AND stripped.
    const result = buildFtsQuery("搜索AND记忆");
    expect(result).not.toBeNull();
    const tokens = result!.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("AND");
    // 搜索 and 记忆 should both survive
    expect(tokens).toContain("搜索");
    expect(tokens).toContain("记忆");
  });

  it("F2: leading AND before CJK removed; CJK preserved", () => {
    // "编程学习" has no stop words；AND removed, CJK content survives
    const result = buildFtsQuery("AND编程学习");
    expect(result).not.toBeNull();
    const tokens = result!.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("AND");
  });

  it("F3: OR surrounded by CJK stripped", () => {
    const result = buildFtsQuery("用户OR编程");
    expect(result).not.toBeNull();
    const tokens = result!.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("OR");
  });

  it("F4: NOT between CJK chars stripped", () => {
    const result = buildFtsQuery("你好NOT世界");
    expect(result).not.toBeNull();
    const tokens = result!.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("NOT");
  });

  // ── Tab / newline handling ──────────────────────

  it("F5: tab characters treated as whitespace", () => {
    const result = buildFtsQuery("hello\tworld");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/^"hello" OR "world"$/);
  });

  it("F6: newline characters treated as whitespace", () => {
    const result = buildFtsQuery("hello\nworld");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/^"hello" OR "world"$/);
  });

  it("F7: mixed whitespace (tab + newline + space + operator)", () => {
    const result = buildFtsQuery("hello\t\n AND \tworld");
    expect(result).not.toBeNull();
    expect(result!).toBe('"hello" OR "world"');
  });

  // ── Emoji / non-BMP handling ────────────────────

  it("F8: emoji preserved (not FTS5 special chars)", () => {
    // Emojis are not FTS5 operators and not stripped
    const result = buildFtsQuery("hello 😀 world");
    expect(result).not.toBeNull();
    // The emoji may or may not be tokenized (depends on jieba/regex)
    // but the surrounding words should survive
    expect(result!).toContain("hello");
    expect(result!).toContain("world");
  });

  it("F9: emoji adjacent to AND — AND stripped, emoji may survive", () => {
    const result = buildFtsQuery("😀AND😀");
    // AND is between emojis (non-\w) → \b on both sides → AND stripped
    if (result !== null) {
      expect(result).not.toMatch(/\bAND\b|"AND"/i);
    }
  });

  // ── Long input ──────────────────────────────────

  it("F10: very long input (5000 chars) — no crash, no OOM", () => {
    const long = "hello world ".repeat(500);
    const result = buildFtsQuery(long);
    expect(result).not.toBeNull();
    // Should produce a valid OR-joined string
    expect(result!).toMatch(/^".+"( OR ".+")*$/);
  });

  it("F11: long input of 纯操作符 → null without crash", () => {
    const longOps = "AND OR NOT NEAR ".repeat(200);
    expect(buildFtsQuery(longOps)).toBeNull();
  });

  // ── Randomised property-based checks ─────────────

  it("F12: RANDOMISED — 500 random small inputs never produce bare FTS5 operators", () => {
    const safeWords = ["hello", "world", "用户", "编程", "test", "data", "搜索", "记忆"];
    const ops = ["AND", "OR", "NOT", "NEAR", "*", "(", ")", '"', "^", "{", "}"];
    // Generate random mixtures and verify output safety
    for (let i = 0; i < 500; i++) {
      // Build a random string: pick 0-4 safe words + 0-3 ops, shuffled
      const parts: string[] = [];
      const wordCount = Math.floor(Math.random() * 5); // 0–4
      const opCount = Math.floor(Math.random() * 4);    // 0–3
      for (let w = 0; w < wordCount; w++) {
        parts.push(safeWords[Math.floor(Math.random() * safeWords.length)]!);
      }
      for (let o = 0; o < opCount; o++) {
        parts.push(ops[Math.floor(Math.random() * ops.length)]!);
      }
      // Shuffle
      for (let j = parts.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        [parts[j], parts[k]] = [parts[k]!, parts[j]!];
      }
      const input = parts.join(" ");

      const result = buildFtsQuery(input);
      if (result !== null) {
        // First: the output format must be valid "token" OR "token" ...
        expect(result).toMatch(/^".+"( OR ".+")*$/);
        // Second: extract the inner token content and verify no ops leak
        const innerTokens = result
          .split(" OR ")
          .map((t) => t.slice(1, -1)); // strip FTS5 phrase-delimiting quotes
        for (const tk of innerTokens) {
          expect(tk).not.toMatch(/\b(AND|OR|NOT|NEAR)\b/i);
          expect(tk).not.toMatch(/[*()"^{}]/);
        }
      }
    }
  });

  it("F13: deterministic edge — all FTS5 special chars individually as input", () => {
    const specials = ["*", "(", ")", '"', "^", "{", "}"];
    for (const ch of specials) {
      const result = buildFtsQuery(ch);
      // Each individually should be null (stripped to empty)
      expect(result).toBeNull();
    }
  });

  it("F14: tail operator after real word — word survives, operator dropped", () => {
    const result = buildFtsQuery("hello AND");
    expect(result).toBe('"hello"');
  });

  it("F15: leading operator + real word — operator dropped, word survives", () => {
    const result = buildFtsQuery("NOT hello");
    expect(result).toBe('"hello"');
  });

  it("F16: ALL FOUR reserved words in a real-looking sentence", () => {
    const result = buildFtsQuery(
      "This is NOT a drill AND we are OR we are NEAR the end"
    );
    expect(result).not.toBeNull();
    const tokens = result!.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("NOT");
    expect(tokens).not.toContain("AND");
    expect(tokens).not.toContain("OR");
    expect(tokens).not.toContain("NEAR");
    // But real words should survive
    expect(tokens).toContain("This");
    expect(tokens).toContain("drill");
    expect(tokens).toContain("end");
  });
});
