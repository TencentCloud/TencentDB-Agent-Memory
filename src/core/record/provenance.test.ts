/**
 * tz-05 Ф1 — provenance core.
 *
 * The interesting cases are the ones the package exists for: a chain that
 * survives an update, a collapse that is visible rather than silent, and an
 * incoming value that must never pass for server-side history.
 */
import { describe, it, expect } from "vitest";
import {
  PROVENANCE_KEY,
  MAX_CHAIN,
  appendStep,
  isCollapsed,
  mergeMetadata,
  readProvenance,
  stripIncomingProvenance,
  type Provenance,
} from "./provenance.js";

const step = (n: number) => ({
  role: `role-${n}`,
  action: "update",
  at: `2026-08-12T00:${String(n).padStart(2, "0")}:00.000Z`,
});

function chainOf(count: number): Provenance {
  let provenance = appendStep(undefined, step(0), "user-input", step(0).at);
  for (let n = 1; n < count; n += 1)
    provenance = appendStep(provenance, step(n), "role-run", step(n).at);
  return provenance;
}

describe("provenance chain", () => {
  it("keeps all three steps of a create → role edit → merge sequence", () => {
    const provenance = chainOf(3);
    expect(provenance.chain).toHaveLength(3);
    expect(
      provenance.chain.map((entry) =>
        isCollapsed(entry) ? "collapsed" : entry.role,
      ),
    ).toEqual(["role-0", "role-1", "role-2"]);
  });

  it("keeps the original source and creation time when later steps arrive", () => {
    const provenance = chainOf(3);
    expect(provenance.source).toBe("user-input");
    expect(provenance.createdAt).toBe(step(0).at);
  });

  it("collapses 24 steps into a visible marker plus 19 live ones", () => {
    const provenance = chainOf(24);
    expect(provenance.chain).toHaveLength(MAX_CHAIN);
    const [first, ...rest] = provenance.chain;
    expect(isCollapsed(first!)).toBe(true);
    expect(first).toEqual({ collapsed: 5, from: step(0).at, to: step(4).at });
    expect(rest.every((entry) => !isCollapsed(entry))).toBe(true);
    expect(rest).toHaveLength(MAX_CHAIN - 1);
  });

  it("never grows a second marker — the existing one absorbs later folds", () => {
    const provenance = chainOf(40);
    expect(provenance.chain.filter(isCollapsed)).toHaveLength(1);
    expect(provenance.chain[0]).toEqual({
      collapsed: 21,
      from: step(0).at,
      to: step(20).at,
    });
    expect(provenance.chain).toHaveLength(MAX_CHAIN);
  });
});

describe("reading provenance back", () => {
  it("reads what was written", () => {
    const metadata = mergeMetadata(
      { topic: "x" },
      undefined,
      step(1),
      "manual",
      step(1).at,
    );
    const read = readProvenance(metadata);
    expect(read?.source).toBe("manual");
    expect(read?.chain).toEqual([step(1)]);
    expect(metadata.topic).toBe("x");
  });

  it.each([
    ["missing", {}],
    ["a string", { [PROVENANCE_KEY]: "nope" }],
    ["null", { [PROVENANCE_KEY]: null }],
    [
      "an unknown source",
      { [PROVENANCE_KEY]: { source: "hacker", createdAt: "t", chain: [] } },
    ],
    ["a truncated object", { [PROVENANCE_KEY]: { source: "manual" } }],
    ["not an object at all", "metadata"],
  ])("survives %s without throwing", (_label, metadata) => {
    expect(readProvenance(metadata)).toBeUndefined();
  });

  it("drops junk entries but keeps the well-formed ones", () => {
    const read = readProvenance({
      [PROVENANCE_KEY]: {
        source: "import",
        createdAt: "t",
        chain: [
          step(1),
          { role: 1 },
          null,
          { collapsed: 2, from: "a", to: "b" },
        ],
      },
    });
    expect(read?.chain).toEqual([
      step(1),
      { collapsed: 2, from: "a", to: "b" },
    ]);
  });
});

describe("the key belongs to the core (A4b)", () => {
  it("strips an incoming value and leaves the rest of the metadata alone", () => {
    const incoming = {
      topic: "x",
      [PROVENANCE_KEY]: { source: "manual", createdAt: "forged", chain: [] },
    };
    expect(stripIncomingProvenance(incoming)).toEqual({ topic: "x" });
  });

  it("a forged incoming chain cannot replace the server-side one", () => {
    const existing = mergeMetadata(
      {},
      undefined,
      step(1),
      "user-input",
      step(1).at,
    );
    const forged = {
      topic: "x",
      [PROVENANCE_KEY]: {
        source: "manual",
        createdAt: "1970-01-01T00:00:00.000Z",
        chain: [step(9)],
      },
    };
    const merged = mergeMetadata(
      forged,
      existing,
      step(2),
      "role-run",
      step(2).at,
    );
    const read = readProvenance(merged);
    expect(read?.source).toBe("user-input");
    expect(read?.createdAt).toBe(step(1).at);
    expect(read?.chain).toEqual([step(1), step(2)]);
    expect(merged.topic).toBe("x");
  });

  it("a record with no previous metadata starts a chain rather than failing", () => {
    const merged = mergeMetadata(
      undefined,
      undefined,
      step(1),
      "import",
      step(1).at,
    );
    expect(readProvenance(merged)?.chain).toEqual([step(1)]);
  });
});
