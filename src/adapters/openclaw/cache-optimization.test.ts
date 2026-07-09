/**
 * Unit tests for the OpenClaw cache-optimization adapter.
 *
 * These tests pin the exact output of `buildCacheOptimizedContext` so the
 * extraction from `auto-recall.ts` is provably faithful (identical strings),
 * and they cover the new `dedupeRecallLines` helper.
 */

import { describe, expect, it } from "vitest";
import {
  buildCacheOptimizedContext,
  dedupeRecallLines,
  MEMORY_TOOLS_GUIDE,
} from "./cache-optimization.js";

const PERSONA = "用户叫王小明，软件工程师";
const SCENE = "Scene1: 项目初始化 (2026-01-15)";
const MEM = ["- [episodic] Memory A"];

describe("buildCacheOptimizedContext — mode: none (legacy)", () => {
  it("no persona/scene/memories → all undefined (caller returns undefined)", () => {
    const r = buildCacheOptimizedContext({ cacheOptimization: "none", memoryLines: [], separator: "\n" });
    expect(r.prependSystemAddition).toBeUndefined();
    expect(r.appendSystemContext).toBeUndefined();
    expect(r.prependContext).toBeUndefined();
  });

  it("persona+scene go to appendSystemContext (after boundary); prependSystemAddition undefined", () => {
    const r = buildCacheOptimizedContext({
      cacheOptimization: "none",
      personaContent: PERSONA,
      sceneNavigation: SCENE,
      memoryLines: [],
      separator: "\n",
    });
    expect(r.prependSystemAddition).toBeUndefined();
    expect(r.appendSystemContext).toContain("<user-persona>");
    expect(r.appendSystemContext).toContain(PERSONA);
    expect(r.appendSystemContext).toContain("<scene-navigation>");
    expect(r.appendSystemContext).toContain(SCENE);
    expect(r.appendSystemContext).toContain("<memory-tools-guide>");
  });

  it("memories → prependContext is <relevant-memories> (no wrapper, no empty placeholder)", () => {
    const r = buildCacheOptimizedContext({ cacheOptimization: "none", memoryLines: MEM, separator: "\n" });
    const expected = `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${MEM.join("\n")}\n</relevant-memories>`;
    expect(r.prependContext).toBe(expected);
  });

  it("empty memories → prependContext undefined (no placeholder in legacy)", () => {
    const r = buildCacheOptimizedContext({ cacheOptimization: "none", memoryLines: [], separator: "\n" });
    expect(r.prependContext).toBeUndefined();
  });
});

describe("buildCacheOptimizedContext — mode: stable_wrapper", () => {
  it("memories → prependContext wrapped in <memory-context state=\"active\">", () => {
    const r = buildCacheOptimizedContext({ cacheOptimization: "stable_wrapper", memoryLines: MEM, separator: "\n" });
    expect(r.prependContext).toContain('<memory-context state="active">');
    expect(r.prependContext).toContain("</memory-context>");
    expect(r.prependContext).toContain(MEM[0]);
  });

  it("empty memories → prependContext is empty placeholder (keeps prefix stable)", () => {
    const r = buildCacheOptimizedContext({ cacheOptimization: "stable_wrapper", memoryLines: [], separator: "\n" });
    expect(r.prependContext).toBe(`<memory-context state="empty"></memory-context>`);
  });

  it("persona still in appendSystemContext (not before boundary in stable_wrapper)", () => {
    const r = buildCacheOptimizedContext({
      cacheOptimization: "stable_wrapper",
      personaContent: PERSONA,
      sceneNavigation: SCENE,
      memoryLines: [],
      separator: "\n",
    });
    expect(r.prependSystemAddition).toBeUndefined();
    expect(r.appendSystemContext).toContain("<user-persona>");
  });
});

describe("buildCacheOptimizedContext — mode: split_system", () => {
  it("persona moves to prependSystemAddition (before boundary); scene+tools stay after", () => {
    const r = buildCacheOptimizedContext({
      cacheOptimization: "split_system",
      personaContent: PERSONA,
      sceneNavigation: SCENE,
      memoryLines: MEM,
      separator: "\n",
    });
    expect(r.prependSystemAddition).toContain("<user-persona>");
    expect(r.prependSystemAddition).toContain(PERSONA);
    expect(r.appendSystemContext).toContain("<scene-navigation>");
    expect(r.appendSystemContext).toContain("<memory-tools-guide>");
    // persona must NOT also appear in appendSystemContext
    expect(r.appendSystemContext).not.toContain("<user-persona>");
  });

  it("memories wrapped with stable_wrapper semantics in split_system too", () => {
    const r = buildCacheOptimizedContext({ cacheOptimization: "split_system", memoryLines: MEM, separator: "\n" });
    expect(r.prependContext).toContain('<memory-context state="active">');
  });
});

describe("buildCacheOptimizedContext — dedup option (absorbs #402 dedup idea)", () => {
  it("dedup=true removes exact-duplicate memory lines, preserving order", () => {
    const lines = ["- [episodic] A", "- [episodic] A", "- [instruction] B", "- [episodic] A"];
    const r = buildCacheOptimizedContext({
      cacheOptimization: "stable_wrapper",
      memoryLines: lines,
      separator: "\n",
      dedup: true,
    });
    expect(r.prependContext).toBe(
      `<memory-context state="active">\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n- [episodic] A\n- [instruction] B\n</memory-context>`,
    );
  });

  it("dedup=false (default) preserves duplicates", () => {
    const lines = ["- [episodic] A", "- [episodic] A"];
    const r = buildCacheOptimizedContext({ cacheOptimization: "stable_wrapper", memoryLines: lines, separator: "\n" });
    expect(r.prependContext).toContain("- [episodic] A\n- [episodic] A");
  });
});

describe("dedupeRecallLines — pure helper", () => {
  it("removes exact duplicates, keeps first-seen order", () => {
    expect(dedupeRecallLines(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
  it("returns a fresh copy (no mutation of input) when no duplicates", () => {
    const input = ["a", "b", "c"];
    const out = dedupeRecallLines(input);
    expect(out).toEqual(["a", "b", "c"]);
    expect(out).not.toBe(input);
  });
  it("handles empty input", () => {
    expect(dedupeRecallLines([])).toEqual([]);
  });
});

describe("MEMORY_TOOLS_GUIDE constant", () => {
  it("is a non-empty guide string", () => {
    expect(typeof MEMORY_TOOLS_GUIDE).toBe("string");
    expect(MEMORY_TOOLS_GUIDE.length).toBeGreaterThan(50);
    expect(MEMORY_TOOLS_GUIDE).toContain("记忆工具调用指南");
  });
});
