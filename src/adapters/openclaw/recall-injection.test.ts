import { describe, expect, it } from "vitest";
import {
  buildOpenClawRecallHookResult,
  OpenClawMemoryEpochLedger,
} from "./recall-injection.js";

const memory = (content: string, type = "episodic") => ({ content, type, score: 0 });
const largeMemory = (label: string) => Array.from(
  { length: 500 },
  (_, index) => `${label}-${index}: preference and event ${index}`,
).join(" | ");

describe("OpenClaw recall placement", () => {
  it("places stable context before the cache boundary and supports legacy dynamic placement", () => {
    expect(buildOpenClawRecallHookResult({
      appendSystemContext: "stable persona",
      prependContext: "dynamic recall",
    }, "prepend")).toEqual({
      prependSystemContext: "stable persona",
      prependContext: "dynamic recall",
    });
    expect(buildOpenClawRecallHookResult({ prependContext: "dynamic recall" }, "append"))
      .toEqual({ appendContext: "dynamic recall" });
  });
});

describe("OpenClaw memory epoch ledger", () => {
  it("persists exact deltas and advances the snapshot only on an explicit cache epoch", () => {
    const ledger = new OpenClawMemoryEpochLedger();
    const session = { sessionKey: "agent:main:test", sessionId: "session-1" };
    const first = ledger.prepare({
      ...session,
      turnId: "turn-1",
      recall: {
        appendSystemContext: "stable-v1",
        stableSnapshotHash: "hash-v1",
        cacheEpoch: 1,
        recalledL1Memories: [memory("memory A"), memory("memory B")],
        recallStrategy: "hybrid",
      },
    });
    const persisted = ledger.persist(session.sessionKey, { role: "user", content: "turn one" });

    expect(persisted?.content).toBe(`${first.prependContext}\n\nturn one`);
    const unchanged = ledger.prepare({
      ...session,
      turnId: "turn-2",
      recall: {
        appendSystemContext: "stable-v2",
        stableSnapshotHash: "hash-v2",
        cacheEpoch: 1,
        recalledL1Memories: [memory("memory A"), memory("memory B")],
        recallStrategy: "hybrid",
      },
    });
    expect(unchanged.prependContext).toBeUndefined();
    expect(unchanged.prependSystemContext).toBe("stable-v1");
    expect(unchanged.stableSnapshotHash).toBe("hash-v1");
    expect(ledger.persist(session.sessionKey, { role: "user", content: "turn two" })).toBeUndefined();

    const changed = ledger.prepare({
      ...session,
      turnId: "turn-3",
      recall: {
        appendSystemContext: "stable-v2",
        stableSnapshotHash: "hash-v2",
        cacheEpoch: 2,
        recalledL1Memories: [memory("memory B"), memory("memory C")],
        recallStrategy: "hybrid",
      },
    });
    expect(changed.prependContext).toContain("memory C");
    expect(changed.prependContext).not.toContain("memory B");
    expect(changed.prependContext).toMatch(/focus: [a-f0-9]{12}, [a-f0-9]{12}/);
    expect(changed.memoryEpoch).toBe(2);
    expect(changed.prependSystemContext).toBe("stable-v2");
    expect(changed.stableSnapshotHash).toBe("hash-v2");
    ledger.persist(session.sessionKey, { role: "user", content: "turn three" });

    const timedOut = ledger.prepare({
      ...session,
      turnId: "turn-4",
      recall: { recalledL1Memories: [], recallStrategy: "timed-out" },
    });
    expect(timedOut.prependContext).toBeUndefined();
    expect(timedOut.memoryEpoch).toBe(2);
    expect(ledger.persist(session.sessionKey, { role: "user", content: "turn four" })).toBeUndefined();

    const switchedBack = ledger.prepare({
      ...session,
      turnId: "turn-5",
      recall: {
        recalledL1Memories: [memory("memory A"), memory("memory B")],
        recallStrategy: "hybrid",
      },
    });
    expect(switchedBack.memoryEpoch).toBe(3);
    expect(switchedBack.prependContext).toContain("focus:");
    expect(switchedBack.prependContext).not.toContain("register:");
    expect(switchedBack.prependContext).not.toContain("memory A");
  });

  it("preserves multiline memories and attachments in the persisted user turn", () => {
    const ledger = new OpenClawMemoryEpochLedger();
    const prepared = ledger.prepare({
      sessionKey: "agent:main:multiline",
      sessionId: "session-1",
      turnId: "turn-1",
      recall: {
        prependContext: "<relevant-memories>\n- [fact] first line\nsecond line\n</relevant-memories>",
        recalledL1Memories: [memory("first line\nsecond -- line", "fact")],
        recallStrategy: "hybrid",
      },
    });
    const image = { type: "image", data: "abc" };
    const persisted = ledger.persist("agent:main:multiline", {
      role: "user",
      content: [{ type: "text", text: "Look at this image" }, image],
    });
    const parts = persisted?.content as Array<Record<string, unknown>>;

    expect(prepared.prependContext).toContain("first line\\nsecond — line");
    expect(parts[0].text).toBe(`${prepared.prependContext}\n\nLook at this image`);
    expect(parts[1]).toBe(image);
  });

  it("seals at the token budget, keeps overflow ephemeral, and reopens after compaction", () => {
    const ledger = new OpenClawMemoryEpochLedger(256);
    const session = { sessionKey: "agent:main:bounded", sessionId: "session-1" };
    const sealed = ledger.prepare({
      ...session,
      turnId: "turn-1",
      recall: {
        recalledL1Memories: [memory(largeMemory("large-A"))],
        recallStrategy: "hybrid",
      },
    });
    const persisted = ledger.persist(session.sessionKey, { role: "user", content: "turn one" });

    expect(sealed.memoryEpochSealed).toBe(true);
    expect(sealed.prependContext).toContain("sealed: token-budget");
    expect(sealed.appendContext).toContain("large-A");
    expect(persisted?.content).not.toContain("large-A");

    const overflow = ledger.prepare({
      ...session,
      turnId: "turn-2",
      recall: {
        recalledL1Memories: [memory(largeMemory("large-B"))],
        recallStrategy: "hybrid",
      },
    });
    expect(overflow.prependContext).toBeUndefined();
    expect(overflow.appendContext).toContain("large-B");
    expect(ledger.persist(session.sessionKey, { role: "user", content: "turn two" })).toBeUndefined();

    ledger.requireCheckpoint(session.sessionKey);
    const checkpoint = ledger.prepare({
      ...session,
      turnId: "turn-3",
      recall: {
        recalledL1Memories: [memory("small current memory")],
        recallStrategy: "hybrid",
      },
    });
    expect(checkpoint.prependContext).toContain("checkpoint");
    expect(checkpoint.prependContext).toContain("small current memory");
    expect(checkpoint.appendContext).toBeUndefined();
    expect(checkpoint.memoryEpochSealed).toBe(false);
  });

  it("carries the frozen snapshot into a compacted session generation", () => {
    const ledger = new OpenClawMemoryEpochLedger(512);
    const sessionKey = "agent:main:rotated";
    const first = ledger.prepare({
      sessionKey,
      sessionId: "generation-1",
      turnId: "turn-1",
      recall: {
        appendSystemContext: "stable-before-compaction",
        stableSnapshotHash: "stable-hash",
        cacheEpoch: 1,
        recalledL1Memories: [memory("old working memory")],
        recallStrategy: "hybrid",
      },
    });
    ledger.persist(sessionKey, { role: "user", content: "before compaction" });
    ledger.requireCheckpoint(sessionKey);

    const rotated = ledger.prepare({
      sessionKey,
      sessionId: "generation-2",
      turnId: "turn-2",
      historyMessages: [],
      recall: {
        appendSystemContext: "newer-global-snapshot",
        stableSnapshotHash: "newer-hash",
        cacheEpoch: 1,
        recalledL1Memories: [memory("current working memory")],
        recallStrategy: "hybrid",
      },
    });
    expect(rotated.prependSystemContext).toBe("stable-before-compaction");
    expect(rotated.stableSnapshotHash).toBe("stable-hash");
    expect(rotated.memoryEpoch).toBe(first.memoryEpoch + 1);
    expect(rotated.prependContext).toContain("current working memory");
    expect(rotated.prependContext).not.toContain("old working memory");
  });

  it("restores registry state from transcript history after a process restart", () => {
    const session = { sessionKey: "agent:main:restart", sessionId: "session-1" };
    const firstProcess = new OpenClawMemoryEpochLedger();
    const first = firstProcess.prepare({
      ...session,
      turnId: "turn-1",
      recall: { recalledL1Memories: [memory("memory A")], recallStrategy: "hybrid" },
    });
    const persisted = firstProcess.persist(session.sessionKey, { role: "user", content: "turn one" });

    const secondProcess = new OpenClawMemoryEpochLedger();
    const unchanged = secondProcess.prepare({
      ...session,
      turnId: "turn-2",
      historyMessages: [persisted],
      recall: { recalledL1Memories: [memory("memory A")], recallStrategy: "hybrid" },
    });
    expect(unchanged.memoryEpoch).toBe(1);
    expect(unchanged.prependContext).toBeUndefined();
    expect(secondProcess.persist(session.sessionKey, { role: "user", content: "turn two" })).toBeUndefined();

    const changed = secondProcess.prepare({
      ...session,
      turnId: "turn-3",
      recall: { recalledL1Memories: [memory("memory B")], recallStrategy: "hybrid" },
    });
    expect(first.prependContext).toContain("memory A");
    expect(changed.memoryEpoch).toBe(2);
    expect(changed.prependContext).toContain("memory B");
  });

  it("correlates concurrent turns in order and reuses the same result on retry", () => {
    const ledger = new OpenClawMemoryEpochLedger();
    const session = { sessionKey: "agent:main:concurrent", sessionId: "session-1" };
    const first = ledger.prepare({
      ...session,
      turnId: "run-a",
      recall: { recalledL1Memories: [memory("memory A")], recallStrategy: "hybrid" },
    });
    const retry = ledger.prepare({
      ...session,
      turnId: "run-a",
      recall: { recalledL1Memories: [memory("retry must not replace A")], recallStrategy: "hybrid" },
    });
    const second = ledger.prepare({
      ...session,
      turnId: "run-b",
      recall: { recalledL1Memories: [memory("memory B")], recallStrategy: "hybrid" },
    });

    const persistedFirst = ledger.persist(session.sessionKey, { role: "user", content: "turn A" });
    const persistedSecond = ledger.persist(session.sessionKey, { role: "user", content: "turn B" });

    expect(retry).toBe(first);
    expect(persistedFirst?.content).toContain("memory A");
    expect(persistedFirst?.content).not.toContain("memory B");
    expect(persistedSecond?.content).toContain("memory B");
    expect(second.memoryEpoch).toBe(2);
  });

  it("bounds persistent growth across high-cardinality turns", () => {
    const ledger = new OpenClawMemoryEpochLedger(512);
    const session = { sessionKey: "agent:main:long", sessionId: "session-1" };
    const persistedTurns: string[] = [];
    let sealedAt = 0;
    let finalTokens = 0;

    for (let turn = 1; turn <= 100; turn += 1) {
      const result = ledger.prepare({
        ...session,
        turnId: `turn-${turn}`,
        recall: {
          recalledL1Memories: [memory(`unique-${turn} ${"content ".repeat(30)}`)],
          recallStrategy: "hybrid",
        },
      });
      const persisted = ledger.persist(session.sessionKey, { role: "user", content: `turn ${turn}` });
      if (persisted?.content) persistedTurns.push(String(persisted.content));
      if (!sealedAt && result.memoryEpochSealed) sealedAt = turn;
      finalTokens = result.memoryEpochTokens;
      expect(result.memoryEpochTokens).toBeLessThanOrEqual(result.memoryEpochTokenBudget);
    }

    expect(sealedAt).toBeGreaterThan(1);
    expect(sealedAt).toBeLessThan(100);
    expect(persistedTurns).toHaveLength(sealedAt);
    expect(finalTokens).toBeLessThanOrEqual(512);
    expect(persistedTurns.join("\n")).not.toContain("unique-100");
  });

  it("limits an epoch to ten percent of the host context budget", () => {
    const result = new OpenClawMemoryEpochLedger(8192).prepare({
      sessionKey: "agent:main:context-budget",
      sessionId: "session-1",
      turnId: "turn-1",
      contextTokenBudget: 4096,
      recall: { recalledL1Memories: [memory("small memory")], recallStrategy: "hybrid" },
    });

    expect(result.memoryEpochTokenBudget).toBe(409);
    expect(result.memoryEpochTokens).toBeLessThan(result.memoryEpochTokenBudget);
  });
});
