/**
 * Unit tests for the scene META summary governor.
 *
 * These cover the review findings that motivated the module:
 *   1. `^summary:\s*(.*)$` swallows the next META line when the value is empty.
 *   2. A whole-file replace rewrites body lines that start with `summary:`.
 *   3. Over-budget summaries are compacted into a jieba keyword index instead of
 *      keeping the first whole sentence (an index, not prose).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  SCENE_SUMMARY_LIMITS,
  clampSceneSummary,
  clampSummaryInSceneFile,
  clampSummaryInText,
  measureSceneSummary,
  normalizeSummary,
} from "./scene-summary.js";
import { _resetJiebaForTest, _setJiebaForTest } from "../text/jieba.js";

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function assertWithinLimits(text: string) {
  const m = measureSceneSummary(text);
  expect(m.chars).toBeLessThanOrEqual(SCENE_SUMMARY_LIMITS.maxChars);
  expect(m.wordEquivalent).toBeLessThanOrEqual(SCENE_SUMMARY_LIMITS.maxWordEquivalent);
  expect(m.exceeds).toBe(false);
  expect(LONE_SURROGATE_RE.test(text)).toBe(false);
}

/**
 * `b` must be a character subsequence of `a`: the clamped summary may only drop
 * text, never reorder or invent it.
 */
function isSubsequence(b: string, a: string): boolean {
  let i = 0;
  for (const ch of a) {
    if (i < b.length && b[i] === ch) i++;
  }
  return i === b.length;
}

const ELLIPSIS_RE = /(?:…|\.\.\.)$/;

const LONG_CJK =
  "用户在后端开发中偏好 Python 异步框架，近期开始接触 Rust 的所有权模型，本次会话中反复讨论内存安全与零拷贝解析，" +
  "同时明确拒绝了打补丁式的临时方案，坚持彻底解耦；此外还记录了部署环境的若干约束，包括容器镜像体积上限与启动时间要求，" +
  "以及团队内部的代码评审规范变更。";

const LONG_EN =
  "The user strongly prefers Python async frameworks for backend work and has recently " +
  "started exploring Rust ownership semantics, repeatedly asking about zero copy parsing " +
  "and memory safety while rejecting any patch style fix in favour of a full decoupling " +
  "of the ingestion pipeline from the storage layer, plus a long list of deployment " +
  "constraints around image size and cold start latency.";

// Function words are placed early so they would survive a naive prefix cut.
const FUNCTION_WORDS_CJK =
  "因为 我们 的 项目 使用 TypeScript 和 Vitest 在 CI 运行 单元 测试 ， 并且 拒绝 本地 集成 测试 ， 所以 " +
  "维护 成本 时常 增加 ， 部署 环境 存在 容器 镜像 体积 上限 与 启动 时间 要求 ， 团队 内部 代码 评审 规范 " +
  "也 有 变更 ， 需要 持续 跟进 记录 迁移 方案 。";

afterEach(() => {
  _resetJiebaForTest();
});

describe("measureSceneSummary", () => {
  it("treats empty input as zero cost", () => {
    const m = measureSceneSummary("");
    expect(m).toEqual({ wordEquivalent: 0, chars: 0, exceeds: false });
  });

  it("counts a Latin word as one and a CJK character as half a word", () => {
    expect(measureSceneSummary("hello world").wordEquivalent).toBe(2);
    expect(measureSceneSummary("用户偏好").wordEquivalent).toBe(2); // 4 CJK chars ≈ 2 words
    expect(measureSceneSummary("用户 prefers Rust").wordEquivalent).toBe(3); // 2 CJK + 2 words
  });

  it("accepts exactly 30 English words when the character cap allows it", () => {
    const text = Array.from({ length: 30 }, () => "word").join(" ");
    const m = measureSceneSummary(text);
    expect(m.wordEquivalent).toBe(30);
    expect(m.chars).toBeLessThanOrEqual(SCENE_SUMMARY_LIMITS.maxChars);
    expect(m.exceeds).toBe(false);
  });

  it("rejects 31 English words", () => {
    const text = Array.from({ length: 31 }, () => "word").join(" ");
    expect(measureSceneSummary(text).exceeds).toBe(true);
  });

  it("rejects 61 CJK characters (30 word-equivalents + 1)", () => {
    expect(measureSceneSummary("用".repeat(61)).exceeds).toBe(true);
    expect(measureSceneSummary("用".repeat(60)).exceeds).toBe(false);
  });

  it("normalizes whitespace and newlines before measuring", () => {
    expect(normalizeSummary("  a\n\nb\t c  ")).toBe("a b c");
    expect(measureSceneSummary("a\n\nb").chars).toBe(3);
  });
});

describe("clampSceneSummary", () => {
  it("returns short input unchanged", () => {
    const text = "用户偏好 Python 异步框架。";
    expect(clampSceneSummary(text)).toBe(text);
  });

  it("leaves input exactly at the character cap untouched", () => {
    const text = "a".repeat(SCENE_SUMMARY_LIMITS.maxChars);
    expect(clampSceneSummary(text)).toBe(text);
  });

  it("compacts an over-budget CJK summary into keywords in original order", () => {
    const out = clampSceneSummary(LONG_CJK);
    assertWithinLimits(out);
    expect(out.endsWith("…")).toBe(true);

    // Every kept character comes from the original, in the original order.
    const body = out.replace(ELLIPSIS_RE, "");
    expect(body.length).toBeGreaterThan(20);
    expect(isSubsequence(body, LONG_CJK)).toBe(true);
    // Content words survive; the char count stays near the ~60 CJK budget.
    expect(out).toContain("Rust");
    expect(Array.from(body).length).toBeGreaterThan(40);
  });

  it("drops function words instead of spending the budget on them", () => {
    const out = clampSceneSummary(FUNCTION_WORDS_CJK);
    assertWithinLimits(out);
    expect(out).not.toContain("因为");
    expect(out).not.toContain("并且");
    expect(out).not.toContain("所以");
    expect(out).toContain("TypeScript");
    expect(out.length).toBeLessThan(FUNCTION_WORDS_CJK.length);
  });

  it("compacts an over-budget English summary into keywords", () => {
    const out = clampSceneSummary(LONG_EN);
    assertWithinLimits(out);
    expect(out.endsWith("...")).toBe(true);
    const body = out.replace(ELLIPSIS_RE, "").trimEnd();
    expect(isSubsequence(body, LONG_EN)).toBe(true);
    // English function words are dropped as well.
    expect(/\bthe\b/i.test(body)).toBe(false);
    expect(body).toContain("Rust");
  });

  it("hard cuts a punctuation-free blob on a code point boundary", () => {
    const out = clampSceneSummary("x".repeat(500));
    assertWithinLimits(out);
    expect(out.endsWith("...")).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    const out = clampSceneSummary("👨‍👩‍👧‍👦".repeat(200));
    assertWithinLimits(out);
    // The sequence contains ZWJ + regional/astral code points; slicing by
    // UTF-16 index would leave a lone surrogate behind.
    expect(LONE_SURROGATE_RE.test(out)).toBe(false);
  });

  it("does not stack a second ellipsis", () => {
    const once = clampSceneSummary(LONG_CJK);
    expect(clampSceneSummary(once)).toBe(once);
    // Already truncated input keeps exactly one trailing marker.
    const already = "摘要已截断…" + "补充说明".repeat(80);
    const out = clampSceneSummary(already);
    expect(out.endsWith("…")).toBe(true);
    expect(out.endsWith("……")).toBe(false);
    expect(out.endsWith("...")).toBe(false);
  });

  it("is idempotent across every sample", () => {
    const samples = [
      LONG_CJK,
      LONG_EN,
      FUNCTION_WORDS_CJK,
      "x".repeat(500),
      "",
      "短摘要",
      "。".repeat(300),
    ];
    for (const s of samples) {
      const once = clampSceneSummary(s);
      expect(clampSceneSummary(once)).toBe(once);
      assertWithinLimits(once);
    }
  });

  it("always satisfies the limits, even for adversarial inputs", () => {
    const samples = [
      LONG_CJK,
      LONG_EN,
      "a".repeat(1000),
      "用".repeat(1000),
      `${"word ".repeat(80)}`,
      "\n\n\n",
      "🙂".repeat(300),
      "的".repeat(600),
    ];
    for (const s of samples) {
      assertWithinLimits(clampSceneSummary(s));
    }
  });

  it("stays bounded on a pathological oversized summary", () => {
    // A scene file is written by the model, so a punctuation-free block of
    // tens of KB is reachable. Cutting one code point at a time while
    // re-measuring the whole string is O(n²) (≈30s at 50k chars), which would
    // stall the L2 round; the budget pre-slice keeps this in the millisecond
    // range, and the keyword loop stops at the first overflow.
    const huge = "用".repeat(200_000);
    const startedAt = Date.now();
    const out = clampSceneSummary(huge);
    const elapsedMs = Date.now() - startedAt;

    assertWithinLimits(out);
    expect(out.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("degrades to an empty string instead of throwing on degenerate limits", () => {
    expect(clampSceneSummary("abcdef", { maxWordEquivalent: 0, maxChars: 0 })).toBe("");
    expect(() => clampSceneSummary("用用用", { maxWordEquivalent: 1, maxChars: 2 })).not.toThrow();
  });
});

describe("clampSceneSummary without jieba", () => {
  it("falls back to a hard cut that still respects the hard cap", () => {
    _setJiebaForTest(null);

    const out = clampSceneSummary(LONG_CJK);
    assertWithinLimits(out);
    expect(out.endsWith("…")).toBe(true);
    // Hard cut keeps a prefix of the original (no keyword compaction).
    expect(LONG_CJK.startsWith(out.replace(ELLIPSIS_RE, ""))).toBe(true);
  });

  it("does not throw when the summary is nothing but function words", () => {
    // With jieba every token is a stop word, so the keyword pass returns an
    // empty string and the caller must fall back without throwing.
    const out = clampSceneSummary("的".repeat(600));
    assertWithinLimits(out);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("clampSummaryInSceneFile", () => {
  const meta = (summary: string) =>
    `-----META-START-----\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-02-02T00:00:00.000Z\nsummary: ${summary}\nheat: 7\n-----META-END-----\n\n## 用户核心特征\n\n正文段落，保持不动。\n`;

  it("clamps only the summary line and keeps every other byte", () => {
    const raw = meta(LONG_CJK.replace(/\n/g, " "));
    const { content, changed } = clampSummaryInSceneFile(raw);
    expect(changed).toBe(true);

    const before = raw.split("\n");
    const after = content.split("\n");
    expect(after.length).toBe(before.length);
    for (const line of ["created: 2026-01-01T00:00:00.000Z", "updated: 2026-02-02T00:00:00.000Z", "heat: 7"]) {
      expect(content).toContain(line);
    }
    expect(content).toContain("## 用户核心特征");
    expect(content).toContain("正文段落，保持不动。");
    expect(after.find((l) => l.startsWith("summary: "))!.length).toBeLessThan(180);
  });

  it("is idempotent (second pass reports no change)", () => {
    const raw = meta(LONG_CJK);
    const first = clampSummaryInSceneFile(raw);
    const second = clampSummaryInSceneFile(first.content);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it("does not swallow the next META line when the summary value is empty", () => {
    const raw = `-----META-START-----\ncreated: c\nupdated: u\nsummary:\nheat: 5\n-----META-END-----\n\nbody`;
    const { content, changed } = clampSummaryInSceneFile(raw);
    expect(changed).toBe(false);
    expect(content).toBe(raw);
    expect(content).toContain("heat: 5");
  });

  it("does not swallow the next line when the summary value is blank", () => {
    const raw = `-----META-START-----\nsummary:   \nheat: 5\n-----META-END-----\n\nbody`;
    expect(clampSummaryInSceneFile(raw).content).toBe(raw);
  });

  it("ignores body lines that start with summary: when there is no META header", () => {
    const raw = `# 场景标题\n\nsummary: ${LONG_CJK}\n\n其他正文`;
    const { content, changed } = clampSummaryInSceneFile(raw);
    expect(changed).toBe(false);
    expect(content).toBe(raw);
  });

  it("ignores files with a broken META header", () => {
    const raw = `-----META-START-----\nsummary: ${LONG_CJK}\n\nbody without end marker`;
    expect(clampSummaryInSceneFile(raw).changed).toBe(false);
  });

  it("treats $& / $1 in the summary as literal text", () => {
    const raw = meta("$&".repeat(120));
    const { content, changed } = clampSummaryInSceneFile(raw);
    expect(changed).toBe(true);
    const line = content.split("\n").find((l) => l.startsWith("summary: "))!;
    expect(line.length).toBeLessThan(180);
    expect(line.startsWith("summary: summary:")).toBe(false);
    expect(content).toContain("heat: 7");
  });

  it("preserves CRLF line endings", () => {
    const raw = `-----META-START-----\r\ncreated: c\r\nupdated: u\r\nsummary: ${LONG_CJK}\r\nheat: 3\r\n-----META-END-----\r\n\r\nbody\r\n`;
    const { content, changed } = clampSummaryInSceneFile(raw);
    expect(changed).toBe(true);
    expect(content).toContain("\r\n");
    expect(content).not.toMatch(/[^\r]\n/);
    expect(content).toContain("heat: 3\r");
  });
});

describe("clampSummaryInText", () => {
  it("returns only the content", () => {
    const raw = `-----META-START-----\nsummary: ${LONG_CJK}\nheat: 1\n-----META-END-----\n\nbody`;
    expect(clampSummaryInText(raw)).toBe(clampSummaryInSceneFile(raw).content);
  });
});
