import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
  buildFtsQuery,
  sanitizeFts5Input,
  bm25RankToScore,
  _setJiebaForTest,
  _resetJiebaForTest,
} from "./sqlite.js";

// ============================
// Suite A: sanitizeFts5Input (pure function, no jieba dependency)
// ============================

describe("sanitizeFts5Input", () => {
  it("A1: normal English text passes through unchanged", () => {
    expect(sanitizeFts5Input("hello world")).toBe("hello world");
  });

  it("A2: normal Chinese text passes through unchanged", () => {
    expect(sanitizeFts5Input("用户喜欢编程")).toBe("用户喜欢编程");
  });

  it("A3: mixed-case OR stripped (\\bOR\\b with /i flag)", () => {
    expect(sanitizeFts5Input("hello Or world")).toBe("hello world");
  });

  it("A4: uppercase AND stripped as standalone word", () => {
    expect(sanitizeFts5Input("cats AND dogs")).toBe("cats dogs");
  });

  it("A5: uppercase OR stripped as standalone word", () => {
    expect(sanitizeFts5Input("tea OR coffee")).toBe("tea coffee");
  });

  it("A6: lowercase not stripped as standalone word", () => {
    expect(sanitizeFts5Input("this not that")).toBe("this that");
  });

  it("A7: leading NOT stripped + whitespace trimmed", () => {
    expect(sanitizeFts5Input("NOT hello")).toBe("hello");
  });

  it("A8: NEAR (mixed case) stripped", () => {
    expect(sanitizeFts5Input("word1 NEAR word2")).toBe("word1 word2");
  });

  it("A9: lowercase near stripped (case-insensitive)", () => {
    expect(sanitizeFts5Input("a near b")).toBe("a b");
  });

  it("A10: ANDROID NOT affected — \\b boundary prevents false match", () => {
    expect(sanitizeFts5Input("ANDROID studio")).toBe("ANDROID studio");
  });

  it("A11: NORTH NOT affected — \bNOT\b does not match inside NORTH", () => {
    expect(sanitizeFts5Input("NORTH south")).toBe("NORTH south");
  });

  it("A12: honorable NOT affected — embedded 'or' is not a word boundary match", () => {
    expect(sanitizeFts5Input("honorable mention")).toBe("honorable mention");
  });

  it("A13: consecutive operators all removed + whitespace collapsed", () => {
    expect(sanitizeFts5Input("AND OR NOT hello")).toBe("hello");
  });

  it("A14: * wildcard character removed", () => {
    expect(sanitizeFts5Input("hello* world")).toBe("hello world");
  });

  it("A15: parentheses ( ) removed", () => {
    expect(sanitizeFts5Input("(hello world)")).toBe("hello world");
  });

  it("A16: ASCII double-quotes \" removed", () => {
    expect(sanitizeFts5Input('"hello world"')).toBe("hello world");
  });

  it("A17: ^ column-prefix character removed", () => {
    expect(sanitizeFts5Input("^hello")).toBe("hello");
  });

  it("A18: { } column-filter braces removed, colon preserved", () => {
    expect(sanitizeFts5Input("{title}: hello")).toBe("title : hello");
  });

  it("A19: all special chars + reserved words removed, whitespace collapsed", () => {
    expect(sanitizeFts5Input('"hello*" AND (world) ^test {col}')).toBe("hello world test col");
  });

  it("A20: only operators / special chars → empty string", () => {
    expect(sanitizeFts5Input('AND OR * ( ) " ^ { }')).toBe("");
  });

  it("A21: consecutive whitespace collapsed to single space", () => {
    expect(sanitizeFts5Input("hello    world")).toBe("hello world");
  });

  it("A22: leading/trailing whitespace trimmed", () => {
    expect(sanitizeFts5Input("  hello world  ")).toBe("hello world");
  });

  it("A23: CJK punctuation preserved (not in FTS5 special char list)", () => {
    expect(sanitizeFts5Input("你好，世界！")).toBe("你好，世界！");
  });

  it("A24: digits preserved", () => {
    expect(sanitizeFts5Input("2024 report v2")).toBe("2024 report v2");
  });

  it("A25: underscore preserved (not an FTS5 special char)", () => {
    expect(sanitizeFts5Input("hello_world func_name")).toBe("hello_world func_name");
  });

  it("A26: Unicode curly quotes (U+201C / U+201D) preserved — not ASCII quote", () => {
    expect(sanitizeFts5Input("“hello” world")).toBe("“hello” world");
  });
});

// ============================
// Suite B: buildFtsQuery — jieba path (real @node-rs/jieba)
// ============================

describe("buildFtsQuery (jieba)", () => {
  it("B1: simple Chinese — returns non-null OR-joined quoted tokens", () => {
    const result = buildFtsQuery("用户喜欢编程");
    expect(result).not.toBeNull();
    // Output should contain "OR" join and quoted tokens
    expect(result!).toMatch(/^".+"( OR ".+")*$/);
  });

  it("B2: Chinese with OR injection — tokens do not contain OR", () => {
    const result = buildFtsQuery("用户 OR 编程");
    expect(result).not.toBeNull();
    // The "OR" keyword should have been stripped; output tokens are all real words
    const tokens = result!.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("OR");
  });

  it("B3: mixed CJK + English — both survive, AND is stripped", () => {
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

  it("B4: * wildcard removed from query", () => {
    const result = buildFtsQuery("搜索*所有*项目");
    expect(result).not.toBeNull();
    // No bare * should remain in the output
    expect(result!).not.toMatch(/(?<!")\*(?!")/);
  });

  it("B5: ASCII double-quotes removed from query", () => {
    const result = buildFtsQuery('"你好" 世界');
    expect(result).not.toBeNull();
    // Each quoted token should not contain internal ASCII double-quotes
    const tokens = result!.split(" OR ");
    for (const t of tokens) {
      const inner = t.slice(1, -1); // strip surrounding quotes
      expect(inner).not.toContain('"');
    }
  });

  it("B6: operators only → null (empty result guard)", () => {
    expect(buildFtsQuery("AND OR NOT")).toBeNull();
  });

  it("B7: special chars only → null", () => {
    expect(buildFtsQuery('( ) * "')).toBeNull();
  });

  it("B8: stop-word-only input → null", () => {
    // "我的一个" are all ZH_STOP_WORDS entries
    expect(buildFtsQuery("我的一个")).toBeNull();
  });

  it("B9: long Chinese sentence → non-null multiple tokens", () => {
    const result = buildFtsQuery("人工智能正在改变世界的方式是前所未有的");
    expect(result).not.toBeNull();
    // Should produce multiple tokens
    const parts = result!.split(" OR ");
    expect(parts.length).toBeGreaterThan(1);
  });

  it("B10: OR-join format — tokens are double-quoted and OR-joined", () => {
    const result = buildFtsQuery("hello world");
    expect(result).not.toBeNull();
    expect(result!).toMatch(/^".+"( OR ".+")*$/);
  });

  it("B11: internal ASCII double-quotes stripped from each token", () => {
    const result = buildFtsQuery('用户说 "你好"');
    expect(result).not.toBeNull();
    // The tokens are FTS5 phrase terms: "用户说" OR "你好"
    // Strip the outer FTS5 phrase quotes and check the inner content
    const tokens = result!.split(" OR ").map((t) => t.slice(1, -1));
    for (const t of tokens) {
      expect(t).not.toContain('"');
    }
  });

  it("B12: deduplication — repeated token appears only once", () => {
    const result = buildFtsQuery("hello hello world");
    expect(result).not.toBeNull();
    const tokens = result!.split(" OR ");
    const helloTokens = tokens.filter((t) => t === '"hello"');
    expect(helloTokens.length).toBe(1);
  });

  it("B13: JSON special chars do not pollute output", () => {
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
// Suite C: buildFtsQuery — fallback path (jieba disabled)
// ============================

describe("buildFtsQuery (fallback — no jieba)", () => {
  beforeAll(() => {
    _setJiebaForTest(null);
  });

  afterAll(() => {
    _resetJiebaForTest();
  });

  it("C1: simple English — regex extracts words correctly", () => {
    const result = buildFtsQuery("hello world");
    expect(result).toBe('"hello" OR "world"');
  });

  it("C2: OR word stripped by sanitize, regex extracts remaining words", () => {
    const result = buildFtsQuery("cats OR dogs");
    expect(result).toBe('"cats" OR "dogs"');
  });

  it("C3: leading NOT stripped", () => {
    const result = buildFtsQuery("NOT hello");
    expect(result).toBe('"hello"');
  });

  it("C4: NEAR removed", () => {
    const result = buildFtsQuery("word1 NEAR word2");
    expect(result).toBe('"word1" OR "word2"');
  });

  it("C5: special chars all removed", () => {
    const result = buildFtsQuery("hello* AND (world)");
    expect(result).toBe('"hello" OR "world"');
  });

  it("C6: mixed-case And removed (case-insensitive \\b)", () => {
    const result = buildFtsQuery("Hello And World");
    expect(result).toBe('"Hello" OR "World"');
  });

  it("C7: pure operators → null", () => {
    expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
  });

  it("C8: Chinese without jieba — CJK chars form one continuous token", () => {
    const result = buildFtsQuery("用户喜欢编程");
    expect(result).toBe('"用户喜欢编程"');
  });

  it("C9: digits + letters — period splits tokens in fallback regex", () => {
    const result = buildFtsQuery("v2.0 release 2024");
    expect(result).toBe('"v2" OR "0" OR "release" OR "2024"');
  });

  it("C10: underscore preserved in regex \\p{L}\\p{N}_", () => {
    const result = buildFtsQuery("hello_world func");
    expect(result).toBe('"hello_world" OR "func"');
  });
});

// ============================
// Suite D: Regression tests (existing behavior unchanged)
// ============================

describe("buildFtsQuery regression", () => {
  it("D1: jieba cutForSearch sub-word splitting unchanged", () => {
    // "北京烤鸭" → jieba produces ["北京", "烤鸭", "北京烤鸭"]
    // One of these sub-words should appear in the output
    const result = buildFtsQuery("北京烤鸭很好吃");
    expect(result).not.toBeNull();
    // At minimum the compound word or its sub-words should be present
    const hasBeiJing = result!.includes("北京");
    const hasKaoYa = result!.includes("烤鸭");
    expect(hasBeiJing || hasKaoYa).toBe(true);
  });

  it("D2: jieba handles English by splitting on whitespace", () => {
    const result = buildFtsQuery("machine learning");
    expect(result).not.toBeNull();
    expect(result!).toContain("machine");
    expect(result!).toContain("learning");
  });

  it("D3: pure whitespace input → null", () => {
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("D4: empty string → null", () => {
    expect(buildFtsQuery("")).toBeNull();
  });

  it("D5: jieba stop-words filtered (input is all stop-words)", () => {
    // "的了在" are all in ZH_STOP_WORDS
    expect(buildFtsQuery("的了在")).toBeNull();
  });

  it("D6: pure punctuation filtered by [\\p{L}\\p{N}] check → null", () => {
    expect(buildFtsQuery("!!!")).toBeNull();
  });

  it("D7: Unicode letters (café, résumé) — characters preserved in output", () => {
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

  it("D8: bm25RankToScore auxiliary function — rank=-5 ≈ 0.833", () => {
    const score = bm25RankToScore(-5);
    expect(score).toBeCloseTo(0.833, 1);
  });
});

// ============================
// Suite E: Security / attack-vector tests
// ============================

describe("buildFtsQuery — security", () => {
  it('E1: quote-escaping attempt " OR "1"="1 — no bare OR in output', () => {
    const result = buildFtsQuery('" OR "1"="1');
    // May be null (all stripped) or a safe query — either is acceptable
    if (result !== null) {
      // If there is output, it must NOT contain unquoted OR/NOT/AND
      const unquoted = result.replace(/" OR "/g, " | "); // hide the join ORs
      expect(unquoted).not.toMatch(/\b(AND|OR|NOT|NEAR)\b/i);
    }
  });

  it("E2: parenthesis injection — no parens or bare OR", () => {
    const result = buildFtsQuery(") OR (1) OR (");
    // Sanitize strips ( ) and OR; "1" survives as a token
    if (result !== null) {
      expect(result).not.toContain("(");
      expect(result).not.toContain(")");
    }
  });

  it("E3: operator stacking — only real words survive", () => {
    const result = buildFtsQuery("AND AND AND hello OR OR OR world");
    expect(result).not.toBeNull();
    // Only the real tokens remain
    const tokens = result!.split(" OR ").map((t) => t.replaceAll('"', ""));
    expect(tokens).not.toContain("AND");
    expect(tokens).not.toContain("OR");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
  });

  it("E4: NEAR with argument — NEAR stripped, 5 retained as literal", () => {
    const result = buildFtsQuery("hello NEAR(5) world");
    expect(result).not.toBeNull();
    // NEAR is stripped, ( ) are stripped, 5 as a digit token remains
    // but that's harmless (literal phrase search for "5")
    expect(result!).not.toMatch(/\bNEAR\b/i);
    expect(result!).not.toContain("(");
    expect(result!).not.toContain(")");
  });

  it("E5: * prefix-wildcard attempt — * removed", () => {
    const result = buildFtsQuery("secret* password*");
    expect(result).not.toBeNull();
    expect(result!).not.toContain("*");
  });

  it("E6: ^ column name attempt — ^ removed", () => {
    const result = buildFtsQuery("^title: hello");
    expect(result).not.toBeNull();
    expect(result!).not.toContain("^");
  });

  it("E7: brace escaping — braces and AND all removed", () => {
    const result = buildFtsQuery("hello} {AND world");
    expect(result).not.toBeNull();
    expect(result!).not.toContain("{");
    expect(result!).not.toContain("}");
    expect(result!).toMatch(/hello.*world/);
  });

  it("E8: many operators + one real word → single token survives", () => {
    const result = buildFtsQuery("OR OR OR hi");
    expect(result).toBe('"hi"');
  });

  it("E9: CORE SAFETY ASSERTION — no bare FTS5 operators in output except the hardcoded OR join", () => {
    // For any input, the output must never contain unquoted AND/OR/NOT/NEAR.
    // The only "OR" in output is the hardcoded ` OR ` between quoted tokens.
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
        // Strip the safe OR-join strings to check for any residual operators
        const withoutJoins = result.replace(/" OR "/g, " | ");
        expect(withoutJoins).not.toMatch(/\b(AND|OR|NOT|NEAR)\b/i);
      }
    }
  });
});

// ============================
// Suite F: Fuzz / adversarial edge cases
// ============================

describe("buildFtsQuery — fuzz & adversarial edge cases", () => {
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

  it("F11: long input of pure operators → null without crash", () => {
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
