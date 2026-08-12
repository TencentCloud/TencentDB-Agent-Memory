/**
 * tz-10b — the assembler is deterministic, budgeted and explainable.
 *
 * The invariants under test are the ones tz-10 names: `context-budget-enforced`
 * (used <= total - reservedForUser; input order does not change included ids)
 * and `context-envelope-complete` (nothing vanishes — every item is either
 * included or excluded with a reason).
 */
import { describe, it, expect } from "vitest";
import { assembleContext, DEFAULT_PRECEDENCE } from "./assemble.js";
import { createCharTokenizer, estimateTokens } from "./tokenizer.js";
import type {
  ContextAssemblerPolicy,
  ContextSegment,
  MemoryItem,
  Tokenizer,
} from "./types.js";

const tokenizer = createCharTokenizer();

const policy: ContextAssemblerPolicy = {
  precedence: DEFAULT_PRECEDENCE,
  reservedForUser: 0,
  dedup: "exact",
};

const request = {
  requestId: "req-1",
  sessionKey: "s",
  sessionId: "s-1",
  projectId: "/repo",
};

function item(
  memoryId: string,
  content: string,
  extra: { kind?: MemoryItem["kind"]; score?: number } = {},
): MemoryItem {
  return {
    schemaVersion: 1,
    memoryId,
    kind: extra.kind ?? "l1",
    content,
    formatable: { type: extra.kind ?? "l1", content },
    scope: { userId: null, projectId: "/repo", scope: "project" },
    provenance: {
      sourceIds: [],
      producer: "test",
      createdAt: "",
      updatedAt: "",
      status: "unknown",
    },
    score: { raw: extra.score ?? 1, final: extra.score ?? 1, reasons: [] },
    tokenCost: 0,
  };
}

/** One block per item plus a static block nobody owns (the tools guide). */
const render = (included: MemoryItem[]): ContextSegment[] => [
  ...included.map((i) => ({
    slot: "prepend" as const,
    itemIds: [i.memoryId],
    text: `<memory id="${i.memoryId}">${i.content}</memory>`,
  })),
  { slot: "append" as const, itemIds: [], text: "GUIDE" },
];

describe("assembleContext: order and dedup", () => {
  it("puts scenes and L1 above persona, and is blind to input order", () => {
    const items = [
      item("p", "persona text", { kind: "persona" }),
      item("l", "l1 text", { kind: "l1" }),
      item("s", "scene text", { kind: "scene" }),
    ];
    const ids = (input: MemoryItem[]): string[] =>
      assembleContext({
        items: input,
        policy,
        budget: { total: 1000, reservedForUser: 0 },
        tokenizer,
        render,
        request,
      }).included.map((i) => i.memoryId);

    expect(ids(items)).toEqual(["s", "l", "p"]);
    expect(ids([...items].reverse())).toEqual(["s", "l", "p"]);
  });

  it("keeps included ids, excluded reasons and used identical over 20 permutations", () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      item(`m${i}`, `memory number ${i} `.repeat(i + 1), { score: 1 - i / 10 }),
    );
    const run = (input: MemoryItem[]) =>
      assembleContext({
        items: input,
        policy,
        budget: { total: 60, reservedForUser: 10 },
        tokenizer,
        render,
        request,
      });
    const first = run(items);
    for (let n = 0; n < 20; n++) {
      // Deterministic shuffle: rotation by n, then swap of two positions.
      const rotated = [
        ...items.slice(n % items.length),
        ...items.slice(0, n % items.length),
      ];
      const swapped = [...rotated];
      const j = n % (items.length - 1);
      [swapped[j], swapped[j + 1]] = [swapped[j + 1]!, swapped[j]!];
      const result = run(swapped);
      expect(result.included.map((i) => i.memoryId)).toEqual(
        first.included.map((i) => i.memoryId),
      );
      expect(
        result.excluded.map((e) => `${e.item.memoryId}:${e.reason}`).sort(),
      ).toEqual(
        first.excluded.map((e) => `${e.item.memoryId}:${e.reason}`).sort(),
      );
      expect(result.budget.used).toBe(first.budget.used);
    }
  });

  it("drops identical content and says so", () => {
    const envelope = assembleContext({
      items: [item("a", "same text"), item("b", "same text")],
      policy,
      budget: { total: 1000, reservedForUser: 0 },
      tokenizer,
      render,
      request,
    });
    expect(envelope.included.map((i) => i.memoryId)).toEqual(["a"]);
    expect(envelope.excluded[0]).toMatchObject({ reason: "dedup:duplicate" });
    expect(envelope.diagnostics.some((d) => d.stage === "dedup")).toBe(true);
  });
});

describe("assembleContext: budget", () => {
  it("never spends the user's reserve, and every item lands somewhere", () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      item(`m${i}`, "x".repeat(80 * (i + 1))),
    );
    const envelope = assembleContext({
      items,
      policy,
      budget: { total: 100, reservedForUser: 40 },
      tokenizer,
      render,
      request,
    });
    expect(envelope.budget.used).toBeLessThanOrEqual(100 - 40);
    expect(envelope.included.length + envelope.excluded.length).toBe(
      items.length,
    );
    expect(envelope.excluded.every((e) => e.reason === "budget")).toBe(true);
  });

  it("enforces the budget on the RENDERED text, not on the item sum", () => {
    // Wrappers cost more than the items themselves: without the recount every
    // item would "fit" and the context would still blow the budget.
    const heavyWrapper: Tokenizer = {
      id: "wrapper-heavy",
      version: "1",
      count: (text) => estimateTokens(text) * 3,
    };
    const items = [item("a", "alpha"), item("b", "beta"), item("c", "gamma")];
    const envelope = assembleContext({
      items,
      policy,
      budget: { total: 40, reservedForUser: 0 },
      tokenizer: heavyWrapper,
      render,
      request,
    });
    expect(envelope.budget.used).toBeLessThanOrEqual(40);
    expect(heavyWrapper.count(envelope.renderedContext)).toBe(
      envelope.budget.used,
    );
    expect(envelope.included.length + envelope.excluded.length).toBe(
      items.length,
    );
  });

  it("reports the wrapper cost as renderOverhead", () => {
    const envelope = assembleContext({
      items: [item("a", "alpha"), item("b", "beta")],
      policy,
      budget: { total: 1000, reservedForUser: 0 },
      tokenizer,
      render,
      request,
    });
    const itemCosts = envelope.included.reduce((s, i) => s + i.tokenCost, 0);
    expect(envelope.budget.renderOverhead).toBe(
      envelope.budget.used - itemCosts,
    );
    expect(envelope.budget.renderOverhead).toBeGreaterThan(0);
    expect(envelope.budget.tokenizerId).toBe("chars-cjk-v1");
  });
});

describe("assembleContext: a broken tokenizer is visible, not silent", () => {
  it("keeps the item, records the failure and still reports a number", () => {
    let calls = 0;
    const flaky: Tokenizer = {
      id: "flaky",
      version: "1",
      count: (text) => {
        calls++;
        if (calls === 2) throw new Error("tokenizer exploded");
        return estimateTokens(text);
      },
    };
    const envelope = assembleContext({
      items: [item("a", "alpha"), item("b", "beta")],
      policy,
      budget: { total: 1000, reservedForUser: 0 },
      tokenizer: flaky,
      render,
      request,
    });
    expect(envelope.included).toHaveLength(2);
    expect(
      envelope.diagnostics.find((d) => d.stage === "tokenize"),
    ).toMatchObject({ code: "tokenizer-failed", itemId: "b" });
    expect(Number.isFinite(envelope.budget.used)).toBe(true);
  });

  it("survives a tokenizer that fails on the full-text recount", () => {
    const failOnLongText: Tokenizer = {
      id: "recount-breaker",
      version: "1",
      count: (text) => {
        if (text.includes("GUIDE")) throw new Error("recount exploded");
        return estimateTokens(text);
      },
    };
    const envelope = assembleContext({
      items: [item("a", "alpha")],
      policy,
      budget: { total: 1000, reservedForUser: 0 },
      tokenizer: failOnLongText,
      render,
      request,
    });
    expect(envelope.diagnostics.some((d) => d.code === "recount-failed")).toBe(
      true,
    );
    expect(envelope.budget.used).toBe(envelope.included[0]!.tokenCost);
    expect(envelope.renderedContext).toContain("alpha");
  });
});
