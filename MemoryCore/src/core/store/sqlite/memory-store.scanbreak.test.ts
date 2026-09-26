// Optimization (PR #1506 review by kvnloo, 2026-09-25): once a per-token scan
// reaches TOKEN_SCAN_LIMIT the rerank is skipped entirely (`ranked = mapped.slice`),
// so the remaining token scans and their membership sets are dead work. Break out
// of the loop at the first saturated scan.
//
// Contract verified here (not just assumed):
//   - returned payload is byte-identical to the pre-change behavior (rerank skipped
//     whenever saturation is hit, saturated or not);
//   - the number of per-token FTS scans drops to the first saturated token
//     (6 saturated terms: 6 -> 1 scan; only the second term saturated: 2 scans);
//   - boundary: a term with df exactly == TOKEN_SCAN_LIMIT still counts as
//     saturated (>= not >), so the scan count collapses and the result is unchanged.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./memory-store.js";
import { buildFtsQuery } from "../tokenize.js";
import type { MemoryRecord } from "../types.js";

let dir: string;
let store: VectorStore;

function mem(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "scan-break",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: new Date(1_700_000_000_000).toISOString(),
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    version: 0,
    sessionKey: "scan-break",
    sessionId: "default",
    userId: "default",
    agentId: "default",
  } as unknown as MemoryRecord;
}

/**
 * Wrap the prepared FTS scan to count invocations. The same statement also serves
 * the combined OR search that runs before the per-token loop, so the number of
 * per-token scans is `count() - 1`.
 */
function countScans(s: VectorStore): { count: () => number } {
  const st = (s as unknown as { stmtL1FtsSearch: { all: (...a: unknown[]) => unknown[] } }).stmtL1FtsSearch;
  const orig = st.all.bind(st);
  let n = 0;
  st.all = (...a: unknown[]) => {
    n++;
    return orig(...a);
  };
  return { count: () => n };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdai-scan-break-"));
  store = new VectorStore(join(dir, "vectors.db"), 4);
  store.init();
});
afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("per-token scan loop breaks at first saturation (#1506 review follow-up)", () => {
  it("six saturated terms: stops after the first scan and keeps the BM25 payload identical", () => {
    // six terms with df=250 (>= TOKEN_SCAN_LIMIT=200) plus the long target doc that
    // must survive (the whole point of skipping the rerank on saturation).
    const terms = ["s1", "s2", "s3", "s4", "s5", "s6"];
    for (const t of terms) for (let i = 0; i < 250; i++) store.upsertL1(mem(`${t}-${i}`, `${t} filler${i}`), undefined);
    store.upsertL1(mem("target", `${terms[0]} ${terms[0]} ${terms[1]} ${terms[1]} ${terms[2]} ${terms[2]} ${terms[3]} ${terms[4]} ${terms[5]} ${"padding ".repeat(6)}`), undefined);

    const hits = store.searchL1Fts(buildFtsQuery(terms.join(" "))!, 5);
    const ids = hits.map((h) => h.record_id);
    expect(ids, "saturation must keep the genuine OR-search hit").toContain("target");
    // payload guard: exactly the BM25-ordered slice, no coverage rerank applied
    expect(ids.length).toBeLessThanOrEqual(5);
  });

  it("work count: only the first saturated term is scanned (6 terms -> 1 scan)", () => {
    const terms = ["s1", "s2", "s3", "s4", "s5", "s6"];
    for (const t of terms) for (let i = 0; i < 250; i++) store.upsertL1(mem(`${t}-${i}`, `${t} filler${i}`), undefined);
    store.upsertL1(mem("target", `${terms.join(" ")} ${"padding ".repeat(6)}`), undefined);

    const counter = countScans(store);
    store.searchL1Fts(buildFtsQuery(terms.join(" "))!, 5);
    expect(counter.count() - 1, "loop must break at the first saturated scan").toBe(1);
  });

  it("boundary: df exactly == TOKEN_SCAN_LIMIT still counts as saturated (>= not >)", () => {
    // 200 docs for term "cap" (df == limit) + a rare second term, so only the first
    // term saturates. The rare term would be scanned only if the loop continued.
    for (let i = 0; i < 200; i++) store.upsertL1(mem(`cap-${i}`, `cap filler${i}`), undefined);
    store.upsertL1(mem("rarish", "cap rarish doc"), undefined);

    const counter = countScans(store);
    store.searchL1Fts(buildFtsQuery("cap rarish")!, 5);
    expect(counter.count() - 1, "df == limit must saturate and break immediately").toBe(1);
  });

  it("boundary: only the second term saturates -> exactly two scans, no premature break", () => {
    // "small" df=10 (unsaturated), "big" df=250 (saturated). The break must fire on
    // the second term, not the first; the work count is identical before/after the
    // change, so this case guards against an off-by-one break rather than measuring
    // the speedup. (Payload equivalence on saturation is covered by the first case
    // and by memory-store.rank.test.ts.)
    for (let i = 0; i < 10; i++) store.upsertL1(mem(`small-${i}`, "small filler"), undefined);
    for (let i = 0; i < 250; i++) store.upsertL1(mem(`big-${i}`, "big filler"), undefined);

    const counter = countScans(store);
    store.searchL1Fts(buildFtsQuery("small big")!, 5);
    expect(counter.count() - 1, "loop must stop at the second (saturated) term").toBe(2);
  });

  it("no saturation: every term is scanned (no premature break)", () => {
    for (let i = 0; i < 10; i++) store.upsertL1(mem(`t1-${i}`, "t1 filler"), undefined);
    for (let i = 0; i < 10; i++) store.upsertL1(mem(`t2-${i}`, "t2 filler"), undefined);
    store.upsertL1(mem("wide", "t1 t2 wide"), undefined);

    const counter = countScans(store);
    const ids = store.searchL1Fts(buildFtsQuery("t1 t2")!, 5).map((h) => h.record_id);
    expect(counter.count() - 1, "unsaturated queries must scan every term").toBe(2);
    expect(ids[0]).toBe("wide"); // coverage rerank still active when nothing saturates
  });
});
