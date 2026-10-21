/**
 * Temporal frame gate self-check (v2 of the usage boost).
 *
 * A memory whose content self-describes as historical ("早期…后来改了") must
 * not have its usage reinforcement applied on now-framed queries — recently
 * consulting a historical memory must not outrank the current convention.
 * Past-framed queries keep the boost (a history question SHOULD surface the
 * historical memory), and memories without historical self-description keep
 * the shipped behavior exactly.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../store/sqlite/memory-store.js";
import { recallL1Candidates } from "./l1-candidate-recall.js";
import { recordMemoryUsage } from "./memory-search.js";
import type { MemoryRecord } from "../record/l1-writer.js";

const dir = mkdtempSync(join(tmpdir(), "tdai-frame-gate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 86_400_000;
const SCOPE = { teamId: "t", userId: "u", agentId: "a" };

function makeRecord(id: string, content: string, ageMs: number): MemoryRecord {
  const ts = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    content,
    type: "instruction",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    sessionKey: "sk-test",
    sessionId: "sid-test",
    teamId: SCOPE.teamId,
    userId: SCOPE.userId,
    agentId: SCOPE.agentId,
  };
}

describe("L1 usage boost temporal frame gate", () => {
  it("withholds the boost from historical-content memories on now-framed queries", async () => {
    const store = new VectorStore(join(dir, "gate.db"), 0);
    store.init();
    store.upsertL1(makeRecord("stale", "订单幂等早期用数据库唯一索引，量大后放弃了", 60 * DAY), undefined);
    store.upsertL1(makeRecord("fresh", "订单幂等的标准做法是请求头 x-idempotency-key 加 redis 锁双保险", 2 * DAY), undefined);

    // baseline: pure similarity order (no usage anywhere)
    const bypass = await recallL1Candidates({ query: "订单幂等的标准做法是什么", topK: 5, vectorStore: store, bypassUsageBoost: true });
    const baselineOrder = bypass.hits.map((r) => r.record_id);

    // the agent consults the historical memory a lot → shipped boost would push
    // it over the current convention on a now-framed query
    for (let i = 0; i < 10; i++) expect(await recordMemoryUsage(store, ["stale"], SCOPE)).toBe(1);

    // now-framed query: the gate withholds the boost → baseline order restored
    const now = await recallL1Candidates({ query: "订单幂等的标准做法是什么", topK: 5, vectorStore: store });
    expect(now.hits.map((r) => r.record_id)).toEqual(baselineOrder);

    // past-framed query: the boost applies — a history question should surface
    // the historical memory that was recently consulted
    const past = await recallL1Candidates({ query: "订单幂等以前是怎么做的", topK: 5, vectorStore: store });
    expect(past.hits[0].record_id).toBe("stale");
    store.close();
  });

  it("keeps the shipped boost for memories without historical self-description", async () => {
    const store = new VectorStore(join(dir, "no-gate.db"), 0);
    store.init();
    // equal-relevance tie, like l1-recall-usage.test.ts — usage must still decide it
    store.upsertL1(makeRecord("cold", "billing service deployment notes", DAY), undefined);
    store.upsertL1(makeRecord("hot", "billing service deployment notes", 30 * DAY), undefined);
    for (let i = 0; i < 10; i++) expect(await recordMemoryUsage(store, ["hot"], SCOPE)).toBe(1);

    const r = await recallL1Candidates({ query: "billing service", topK: 5, vectorStore: store });
    expect(r.hits.map((x) => x.record_id)).toEqual(["hot", "cold"]);
    store.close();
  });

  it("never reorders anything when there is no usage data", async () => {
    const store = new VectorStore(join(dir, "cold.db"), 0);
    store.init();
    store.upsertL1(makeRecord("stale", "网关限流早期是每用户 100 rpm，后来改了", 60 * DAY), undefined);
    store.upsertL1(makeRecord("fresh", "网关限流现在是每用户 200 rpm，超出返回 429", 2 * DAY), undefined);

    const bypass = await recallL1Candidates({ query: "网关 限流 现在是多少", topK: 5, vectorStore: store, bypassUsageBoost: true });
    const gated = await recallL1Candidates({ query: "网关 限流 现在是多少", topK: 5, vectorStore: store });
    expect(gated.hits.map((r) => r.record_id)).toEqual(bypass.hits.map((r) => r.record_id));
    store.close();
  });
});
