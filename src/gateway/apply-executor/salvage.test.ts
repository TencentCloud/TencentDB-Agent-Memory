/**
 * Shape salvage: a broken operation is dropped and named, the batch lives.
 *
 * Anchored on run f947be67 (night-keeper, 2026-08-14), which presented 362
 * records, ran the model for 16 minutes and applied nothing because the result
 * carried `"rewritePersona": null` and the whole-diff parse turned that into
 * `Invalid apply request` for everything.
 */
import { describe, it, expect } from "vitest";
import { salvageDiff, isEmptyDiff, rejectionSummary } from "./salvage.js";
import { ApplyValidationError } from "./errors.js";
import { MAX_DELETE_L1_OPS } from "../limits.js";
import type { RejectedOp } from "./types.js";

const DELETE = { id: "m_1", updatedAt: "2026-08-15T00:00:00Z" };
const MERGE = { cluster: ["m_1", "m_2"], target: "m_1", content: "merged" };

function salvage(raw: unknown): {
  diff: ReturnType<typeof salvageDiff>;
  rejected: RejectedOp[];
} {
  const rejected: RejectedOp[] = [];
  return { diff: salvageDiff(raw, rejected), rejected };
}

describe("salvageDiff", () => {
  it("reads null in any optional section as 'the section is absent'", () => {
    const { diff, rejected } = salvage({
      deleteL1: null,
      merge: null,
      rewriteBlock: null,
      rewriteRecord: null,
      rewritePersona: null,
    });
    expect(rejected).toEqual([]);
    expect(isEmptyDiff(diff)).toBe(true);
  });

  // The literal reproduction of f947be67: one null next to real work.
  it("keeps the real work standing next to a null persona", () => {
    const { diff, rejected } = salvage({
      deleteL1: [DELETE],
      rewritePersona: null,
    });
    expect(rejected).toEqual([]);
    expect(diff.deleteL1).toEqual([DELETE]);
  });

  it("drops one malformed element and keeps its neighbours", () => {
    const { diff, rejected } = salvage({
      deleteL1: [DELETE, { id: "m_2", updatedAt: 7 }],
    });
    expect(diff.deleteL1).toEqual([DELETE]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.section).toBe("deleteL1");
    expect(rejected[0]!.ref).toBe("m_2");
  });

  // An LLM adding an explanatory field is the likeliest malformed element
  // there is, and it used to cost the whole batch.
  it("drops an element that carries an extra key", () => {
    const { diff, rejected } = salvage({
      deleteL1: [
        { ...DELETE, reason: "duplicate" },
        { ...DELETE, id: "m_2" },
      ],
    });
    expect(diff.deleteL1).toHaveLength(1);
    expect(diff.deleteL1![0]!.id).toBe("m_2");
    expect(rejected[0]!.ref).toBe("m_1");
  });

  it("names an unnameable element by its position", () => {
    const { rejected } = salvage({ merge: ["not an object"] });
    expect(rejected[0]!.ref).toBe("#0");
  });

  it("refuses an unknown section without touching the known ones", () => {
    const { diff, rejected } = salvage({ deleteL1: [DELETE], notes: "hello" });
    expect(diff.deleteL1).toEqual([DELETE]);
    expect(rejected).toEqual([
      { section: "notes", ref: "-", reason: "unknown diff section" },
    ]);
  });

  it("refuses a section that is not an array", () => {
    const { diff, rejected } = salvage({ merge: { target: "m_1" } });
    expect(diff.merge).toBeUndefined();
    expect(rejected[0]!.reason).toMatch(/expected an array, got object/);
  });

  it("refuses a non-string persona", () => {
    const { diff, rejected } = salvage({ rewritePersona: 42 });
    expect(diff.rewritePersona).toBeUndefined();
    expect(rejected[0]!.section).toBe("rewritePersona");
  });

  // A member of a merge that will not run must not be deleted on its own: the
  // merge is gone, so its content is folded nowhere.
  it("takes the delete of a member down with a shape-refused merge", () => {
    const { diff, rejected } = salvage({
      merge: [{ ...MERGE, bogus: true }],
      deleteL1: [{ id: "m_2", updatedAt: "2026-08-15T00:00:00Z" }],
    });
    expect(diff.merge).toBeUndefined();
    expect(diff.deleteL1).toBeUndefined();
    expect(rejected.map((r) => r.section).sort()).toEqual([
      "deleteL1",
      "merge",
    ]);
  });

  it("leaves a healthy diff untouched", () => {
    const { diff, rejected } = salvage({ deleteL1: [DELETE], merge: [MERGE] });
    expect(rejected).toEqual([]);
    expect(diff).toEqual({ deleteL1: [DELETE], merge: [MERGE] });
  });

  // The two whole-request refusals that survive: they say the role's contract
  // is broken wholesale, not that one op is malformed.
  it("refuses the whole request when the diff is not an object", () => {
    expect(() => salvage("nope")).toThrow(ApplyValidationError);
    expect(() => salvage([DELETE])).toThrow(/must be an object, got array/);
  });

  it("refuses the whole request when a section is over its count cap", () => {
    const many = Array.from({ length: MAX_DELETE_L1_OPS + 1 }, (_, i) => ({
      id: `m_${i}`,
      updatedAt: "2026-08-15T00:00:00Z",
    }));
    expect(() => salvage({ deleteL1: many })).toThrow(/over the cap of/);
  });
});

describe("rejectionSummary", () => {
  it("names every refusal with its section, ref and reason", () => {
    const summary = rejectionSummary([
      { section: "deleteL1", ref: "m_1", reason: "not presented" },
      { section: "rewritePersona", ref: "-", reason: "content is blank" },
    ]);
    expect(summary).toBe(
      "deleteL1[m_1]: not presented; rewritePersona[-]: content is blank",
    );
  });
});
