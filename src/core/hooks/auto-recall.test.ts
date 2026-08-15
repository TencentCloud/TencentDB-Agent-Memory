/**
 * Cache-safe recall unit tests (issue #120).
 *
 * Focus:
 *  - Deterministic ordering by id survives insertion-order shuffling.
 *  - Placement routing writes to the correct RecallResult field per config.
 *
 * These tests exercise the pure helpers, not the full recall pipeline.
 */
import { describe, expect, it } from "vitest";
import { routeRecallPlacement, sortMemoriesForCache } from "./auto-recall.js";

describe("sortMemoriesForCache", () => {
  it("orders by id, ignoring insertion order and score", () => {
    const a = sortMemoriesForCache([
      { id: "m-3", type: "episodic", content: "c3" },
      { id: "m-1", type: "episodic", content: "c1" },
      { id: "m-2", type: "persona",  content: "c2" },
    ]).map((m) => m.id);
    const b = sortMemoriesForCache([
      { id: "m-2", type: "persona",  content: "c2" },
      { id: "m-3", type: "episodic", content: "c3" },
      { id: "m-1", type: "episodic", content: "c1" },
    ]).map((m) => m.id);
    expect(a).toEqual(["m-1", "m-2", "m-3"]);
    expect(a).toEqual(b);
  });

  it("falls back to (type, content) when id is missing", () => {
    const out = sortMemoriesForCache([
      { type: "episodic", content: "b" },
      { type: "episodic", content: "a" },
      { type: "persona",  content: "z" },
    ]);
    expect(out.map((m) => `${m.type}:${m.content}`)).toEqual([
      "episodic:a", "episodic:b", "persona:z",
    ]);
  });

  it("is a pure sort — does not mutate input", () => {
    const input = [
      { id: "m-2", type: "episodic", content: "c" },
      { id: "m-1", type: "episodic", content: "c" },
    ];
    const before = input.map((m) => m.id);
    sortMemoriesForCache(input);
    expect(input.map((m) => m.id)).toEqual(before);
  });
});

describe("routeRecallPlacement", () => {
  const block = "<relevant-memories>x</relevant-memories>";

  it("empty block → empty routing", () => {
    expect(routeRecallPlacement(undefined, "user-prefix")).toEqual({});
    expect(routeRecallPlacement("",        "system-tail-dynamic")).toEqual({});
  });

  it("user-prefix → prependContext only", () => {
    const r = routeRecallPlacement(block, "user-prefix");
    expect(r).toEqual({ prependContext: block });
  });

  it("system-tail-dynamic → appendContext only", () => {
    const r = routeRecallPlacement(block, "system-tail-dynamic");
    expect(r).toEqual({ appendContext: block });
  });

  it("system-tail-cacheable → appendSystemContext (folded into stable region)", () => {
    const r = routeRecallPlacement(block, "system-tail-cacheable");
    expect(r).toEqual({ appendSystemContext: block });
  });
});
