import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { parseConfig } from "../config.js";
import { shapeRecallForOpenClawHook } from "../adapters/openclaw/recall-injection.js";
import {
  describeRecallShape,
  noteStableContinuity,
  getLastStableHash,
  resetStableContinuityForTests,
  longestCommonPrefixLength,
} from "./recall-shape-diagnostics.js";
import {
  hasRelevantMemories,
  stripRelevantMemories,
  stripRelevantMemoriesFromContent,
} from "./relevant-memories.js";

describe("recall.injectionMode / showInjected config", () => {
  it("defaults to prepend + showInjected false + dualEmitStable false", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.injectionMode).toBe("prepend");
    expect(cfg.recall.showInjected).toBe(false);
    expect(cfg.recall.dualEmitStable).toBe(false);
  });

  it("accepts append injectionMode and showInjected true", () => {
    const cfg = parseConfig({
      recall: { injectionMode: "append", showInjected: true },
    });
    expect(cfg.recall.injectionMode).toBe("append");
    expect(cfg.recall.showInjected).toBe(true);
  });

  it("falls back invalid injectionMode to prepend", () => {
    const cfg = parseConfig({
      recall: { injectionMode: "sideways" as unknown as string },
    });
    expect(cfg.recall.injectionMode).toBe("prepend");
  });
});

describe("shapeRecallForOpenClawHook", () => {
  const coreResult = {
    appendSystemContext: "<user-persona>\nstable\n</user-persona>",
    prependContext: "<relevant-memories>\ndyn\n</relevant-memories>",
  };

  it("maps stable to prependSystemContext and dynamic to prependContext by default", () => {
    const shaped = shapeRecallForOpenClawHook(coreResult);
    expect(shaped?.prependSystemContext).toBe(coreResult.appendSystemContext);
    expect(shaped?.appendSystemContext).toBeUndefined();
    expect(shaped?.prependContext).toBe(coreResult.prependContext);
    expect(shaped?.appendContext).toBeUndefined();
  });

  it("maps dynamic to appendContext when injectionMode=append", () => {
    const shaped = shapeRecallForOpenClawHook(coreResult, { injectionMode: "append" });
    expect(shaped?.prependSystemContext).toBe(coreResult.appendSystemContext);
    expect(shaped?.prependContext).toBeUndefined();
    expect(shaped?.appendContext).toBe(coreResult.prependContext);
  });

  it("dualEmitStable also sets appendSystemContext", () => {
    const shaped = shapeRecallForOpenClawHook(coreResult, { dualEmitStable: true });
    expect(shaped?.prependSystemContext).toBe(coreResult.appendSystemContext);
    expect(shaped?.appendSystemContext).toBe(coreResult.appendSystemContext);
  });

  it("preserves original stable bytes (no destructive trim)", () => {
    const withNl = {
      appendSystemContext: "stable-block\n",
      prependContext: "dyn",
    };
    const shaped = shapeRecallForOpenClawHook(withNl);
    expect(shaped?.prependSystemContext).toBe("stable-block\n");
  });

  it("drops whitespace-only stable/dynamic", () => {
    expect(
      shapeRecallForOpenClawHook({ appendSystemContext: "   ", prependContext: "\n" }),
    ).toBeUndefined();
  });

  it("returns undefined for empty result", () => {
    expect(shapeRecallForOpenClawHook({})).toBeUndefined();
    expect(shapeRecallForOpenClawHook(undefined)).toBeUndefined();
  });
});

describe("relevant-memories strip", () => {
  it("strips string content", () => {
    const raw =
      "<relevant-memories>\nfoo\n</relevant-memories>\n\nhello";
    expect(hasRelevantMemories(raw)).toBe(true);
    expect(stripRelevantMemories(raw)).toBe("hello");
  });

  it("strips multipart parts", () => {
    const content = [
      { type: "text", text: "<relevant-memories>x</relevant-memories>\n\nhi" },
      { type: "image", url: "data:..." },
    ];
    const out = stripRelevantMemoriesFromContent(content);
    expect(out).toBeDefined();
    expect((out!.content as Array<{ text?: string }>)[0].text).toBe("hi");
    expect(out!.strippedChars).toBeGreaterThan(0);
  });

  it("no-ops when no tags", () => {
    expect(stripRelevantMemoriesFromContent("plain")).toBeUndefined();
  });
});

describe("describeRecallShape", () => {
  it("hashes stable prependSystemContext and reports dynamic placement", () => {
    const stable = "persona-block";
    const d = describeRecallShape({
      prependSystemContext: stable,
      prependContext: "dyn",
    });
    const expected = createHash("sha256").update(stable, "utf8").digest("hex").slice(0, 12);
    expect(d.stableHash).toBe(expected);
    expect(d.dynamicPlacement).toBe("prepend");
    expect(d.line).toContain("stable=");
    expect(d.line).toContain("dynamic=prepend/");
  });

  it("is stable across identical inputs", () => {
    const a = describeRecallShape({ prependSystemContext: "same", appendContext: "x" });
    const b = describeRecallShape({ prependSystemContext: "same", appendContext: "x" });
    expect(a.stableHash).toBe(b.stableHash);
    expect(a.dynamicPlacement).toBe("append");
  });
});

describe("stable continuity (observe-only)", () => {
  it("tracks first → same → changed without freezing content", () => {
    resetStableContinuityForTests();
    expect(noteStableContinuity("s1", "aaa")).toBe("first");
    expect(noteStableContinuity("s1", "aaa")).toBe("same");
    expect(noteStableContinuity("s1", "bbb")).toBe("changed");
    expect(getLastStableHash("s1")).toBe("bbb");
    expect(noteStableContinuity("s2", "aaa")).toBe("first");
  });
});

describe("multi-turn system prefix LCP (pure shape)", () => {
  it("keeps full system prefix when only dynamic L1 changes", () => {
    const stable = "<user-persona>\nP\n</user-persona>\n\n<memory-tools-guide>\nG\n</memory-tools-guide>";
    const t1 = shapeRecallForOpenClawHook({
      appendSystemContext: stable,
      prependContext: "<relevant-memories>\nA\n</relevant-memories>",
    })!;
    const t2 = shapeRecallForOpenClawHook({
      appendSystemContext: stable,
      prependContext: "<relevant-memories>\nB-different\n</relevant-memories>",
    })!;
    // System side is byte-identical across turns (dynamic is user-side only).
    expect(t1.prependSystemContext).toBe(t2.prependSystemContext);
    expect(t1.prependContext).not.toBe(t2.prependContext);
    const lcp = longestCommonPrefixLength(t1.prependSystemContext!, t2.prependSystemContext!);
    expect(lcp).toBe(stable.length);
  });

  it("append mode keeps dynamic off the user prefix field", () => {
    const shaped = shapeRecallForOpenClawHook(
      {
        appendSystemContext: "S",
        prependContext: "D",
      },
      { injectionMode: "append" },
    )!;
    expect(shaped.prependContext).toBeUndefined();
    expect(shaped.appendContext).toBe("D");
    expect(shaped.prependSystemContext).toBe("S");
  });
});

