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

describe("OpenClaw legacy recall placement", () => {
  it("maps stable context before the host system prompt", () => {
    expect(buildOpenClawRecallHookResult({
      appendSystemContext: "stable persona",
      prependContext: "dynamic recall",
    }, "prepend")).toEqual({
      prependSystemContext: "stable persona",
      prependContext: "dynamic recall",
    });
  });

  it("keeps append mode available", () => {
    expect(buildOpenClawRecallHookResult({ prependContext: "dynamic recall" }, "append"))
      .toEqual({ appendContext: "dynamic recall" });
  });
});

describe("OpenClaw memory epoch ledger", () => {
  it("persists exactly the bytes shown to the model and suppresses duplicate recall", () => {
    const ledger = new OpenClawMemoryEpochLedger();
    const first = ledger.prepare({
      sessionKey: "agent:main:test",
      sessionId: "session-1",
      recall: {
        appendSystemContext: "stable-v1",
        stableSnapshotHash: "hash-v1",
        recalledL1Memories: [memory("prefers concise answers")],
        recallStrategy: "hybrid",
      },
    });

    expect(first.prependContext).toContain("tdai-memory-epoch:1 delta");
    const persisted = ledger.persist("agent:main:test", {
      role: "user",
      content: "Explain the cache result.",
    });
    expect(persisted?.content).toBe(`${first.prependContext}\n\nExplain the cache result.`);

    const second = ledger.prepare({
      sessionKey: "agent:main:test",
      sessionId: "session-1",
      recall: {
        appendSystemContext: "stable-v2",
        stableSnapshotHash: "hash-v2",
        recalledL1Memories: [memory("prefers concise answers")],
        recallStrategy: "hybrid",
      },
    });

    expect(second.prependContext).toBeUndefined();
    expect(second.prependSystemContext).toBe("stable-v1");
    expect(second.stableSnapshotHash).toBe("hash-v1");
    expect(second.memoryEpoch).toBe(1);
  });

  it("registers the complete structured memory when formatted recall spans lines", () => {
    const ledger = new OpenClawMemoryEpochLedger();
    const result = ledger.prepare({
      sessionKey: "agent:main:multiline",
      sessionId: "session-1",
      recall: {
        prependContext: "<relevant-memories>\n- [fact] first line\nsecond line\n</relevant-memories>",
        recalledL1Memories: [memory("first line\nsecond line", "fact")],
        recallStrategy: "hybrid",
      },
    });

    expect(result.prependContext).toContain("first line\\nsecond line");
  });

  it("registers new content once and changes focus by ID", () => {
    const ledger = new OpenClawMemoryEpochLedger();
    const session = { sessionKey: "agent:main:test", sessionId: "session-1" };
    ledger.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory("memory A"), memory("memory B")],
        recallStrategy: "hybrid",
      },
    });
    ledger.persist(session.sessionKey, { role: "user", content: "turn one" });

    const changed = ledger.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory("memory B"), memory("memory C")],
        recallStrategy: "hybrid",
      },
    });

    expect(changed.prependContext).toContain("memory C");
    expect(changed.prependContext).not.toContain("memory B");
    expect(changed.prependContext).toMatch(/focus: [a-f0-9]{12}, [a-f0-9]{12}/);
    expect(changed.memoryEpoch).toBe(2);

    ledger.persist(session.sessionKey, { role: "user", content: "turn two" });
    const switchedBack = ledger.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory("memory A"), memory("memory B")],
        recallStrategy: "hybrid",
      },
    });
    expect(switchedBack.memoryEpoch).toBe(3);
    expect(switchedBack.prependContext).toContain("focus:");
    expect(switchedBack.prependContext).not.toContain("register:");
    expect(switchedBack.prependContext).not.toContain("memory A");
    expect(switchedBack.prependContext).not.toContain("memory B");
  });

  it("does not change focus when recall times out", () => {
    const ledger = new OpenClawMemoryEpochLedger();
    const session = { sessionKey: "agent:main:test", sessionId: "session-1" };
    ledger.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory("memory A")],
        recallStrategy: "hybrid",
      },
    });

    const timedOut = ledger.prepare({
      ...session,
      recall: { recalledL1Memories: [], recallStrategy: "timed-out" },
    });
    expect(timedOut.prependContext).toBeUndefined();
    expect(timedOut.memoryEpoch).toBe(1);
  });

  it("writes one full checkpoint after compaction", () => {
    const ledger = new OpenClawMemoryEpochLedger();
    const session = { sessionKey: "agent:main:test", sessionId: "session-1" };
    ledger.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory("memory A"), memory("memory B")],
        recallStrategy: "hybrid",
      },
    });
    ledger.requireCheckpoint(session.sessionKey);

    const checkpoint = ledger.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory("memory A"), memory("memory B")],
        recallStrategy: "hybrid",
      },
    });
    expect(checkpoint.prependContext).toContain("tdai-memory-epoch:2 checkpoint");
    expect(checkpoint.prependContext).toContain("memory A");
    expect(checkpoint.prependContext).toContain("memory B");

    const next = ledger.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory("memory A"), memory("memory B")],
        recallStrategy: "hybrid",
      },
    });
    expect(next.prependContext).toBeUndefined();
  });

  it("seals a full epoch and keeps overflow recall out of history", () => {
    const ledger = new OpenClawMemoryEpochLedger(256);
    const session = { sessionKey: "agent:main:bounded", sessionId: "session-1" };
    const first = ledger.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory(largeMemory("large-A"))],
        recallStrategy: "hybrid",
      },
    });

    expect(first.memoryEpochSealed).toBe(true);
    expect(first.prependContext).toContain("sealed: token-budget");
    expect(first.appendContext).toContain("large-A");
    expect(first.memoryEpochTokens).toBeLessThanOrEqual(first.memoryEpochTokenBudget);

    const persisted = ledger.persist(session.sessionKey, { role: "user", content: "turn one" });
    expect(persisted?.content).toContain("sealed: token-budget");
    expect(persisted?.content).not.toContain("large-A");

    const second = ledger.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory(largeMemory("large-B"))],
        recallStrategy: "hybrid",
      },
    });
    expect(second.prependContext).toBeUndefined();
    expect(second.appendContext).toContain("large-B");
    expect(second.memoryEpoch).toBe(first.memoryEpoch);
    expect(second.memoryEpochTokens).toBe(first.memoryEpochTokens);
    expect(ledger.persist(session.sessionKey, { role: "user", content: "turn two" })).toBeUndefined();
  });

  it("reopens a sealed registry with the current working set after compaction", () => {
    const ledger = new OpenClawMemoryEpochLedger(256);
    const session = { sessionKey: "agent:main:rollover", sessionId: "session-1" };
    ledger.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory(largeMemory("before-rollover"))],
        recallStrategy: "hybrid",
      },
    });
    ledger.persist(session.sessionKey, { role: "user", content: "before compaction" });
    ledger.requireCheckpoint(session.sessionKey);

    const checkpoint = ledger.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory("small current memory")],
        recallStrategy: "hybrid",
      },
    });
    expect(checkpoint.prependContext).toContain("checkpoint");
    expect(checkpoint.prependContext).toContain("small current memory");
    expect(checkpoint.appendContext).toBeUndefined();
    expect(checkpoint.memoryEpochSealed).toBe(false);
    expect(checkpoint.memoryEpochTokens).toBeLessThan(checkpoint.memoryEpochTokenBudget);
  });

  it("carries the stable snapshot into a rotated compaction generation", () => {
    const ledger = new OpenClawMemoryEpochLedger(512);
    const sessionKey = "agent:main:rotated";
    const first = ledger.prepare({
      sessionKey,
      sessionId: "generation-1",
      recall: {
        appendSystemContext: "stable-before-compaction",
        stableSnapshotHash: "stable-hash",
        recalledL1Memories: [memory("old working memory")],
        recallStrategy: "hybrid",
      },
    });
    ledger.persist(sessionKey, { role: "user", content: "before compaction" });
    ledger.requireCheckpoint(sessionKey);

    const rotated = ledger.prepare({
      sessionKey,
      sessionId: "generation-2",
      historyMessages: [],
      recall: {
        appendSystemContext: "newer-global-snapshot",
        stableSnapshotHash: "newer-hash",
        recalledL1Memories: [memory("current working memory")],
        recallStrategy: "hybrid",
      },
    });

    expect(rotated.prependSystemContext).toBe("stable-before-compaction");
    expect(rotated.stableSnapshotHash).toBe("stable-hash");
    expect(rotated.memoryEpoch).toBe(first.memoryEpoch + 1);
    expect(rotated.prependContext).toContain("checkpoint");
    expect(rotated.prependContext).toContain("current working memory");
    expect(rotated.prependContext).not.toContain("old working memory");
  });

  it("restores a sealed token budget after a process restart", () => {
    const session = { sessionKey: "agent:main:restart-sealed", sessionId: "session-1" };
    const firstProcess = new OpenClawMemoryEpochLedger(256);
    const sealed = firstProcess.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory(largeMemory("before-restart"))],
        recallStrategy: "hybrid",
      },
    });
    const persisted = firstProcess.persist(session.sessionKey, { role: "user", content: "turn one" });

    const secondProcess = new OpenClawMemoryEpochLedger(256);
    const restored = secondProcess.prepare({
      ...session,
      historyMessages: [persisted],
      recall: {
        recalledL1Memories: [memory("new current memory")],
        recallStrategy: "hybrid",
      },
    });
    expect(restored.memoryEpochSealed).toBe(true);
    expect(restored.memoryEpochTokens).toBe(sealed.memoryEpochTokens);
    expect(restored.prependContext).toBeUndefined();
    expect(restored.appendContext).toContain("new current memory");
  });

  it("bounds persistent memory growth across high-cardinality turns", () => {
    const ledger = new OpenClawMemoryEpochLedger(512);
    const session = { sessionKey: "agent:main:long", sessionId: "session-1" };
    const persistedTurns: string[] = [];
    let sealedAt = 0;
    let finalTokens = 0;

    for (let turn = 1; turn <= 100; turn += 1) {
      const result = ledger.prepare({
        ...session,
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

  it("uses ten percent of the resolved host context as the effective ceiling", () => {
    const ledger = new OpenClawMemoryEpochLedger(8192);
    const result = ledger.prepare({
      sessionKey: "agent:main:context-budget",
      sessionId: "session-1",
      contextTokenBudget: 4096,
      recall: {
        recalledL1Memories: [memory("small memory")],
        recallStrategy: "hybrid",
      },
    });

    expect(result.memoryEpochTokenBudget).toBe(409);
    expect(result.memoryEpochTokens).toBeLessThan(result.memoryEpochTokenBudget);
  });

  it("persists the epoch in the first text part without changing attachments", () => {
    const ledger = new OpenClawMemoryEpochLedger();
    const prepared = ledger.prepare({
      sessionKey: "agent:main:test",
      sessionId: "session-1",
      recall: {
        recalledL1Memories: [memory("memory -- with comment delimiter")],
        recallStrategy: "hybrid",
      },
    });
    const image = { type: "image", data: "abc" };
    const persisted = ledger.persist("agent:main:test", {
      role: "user",
      content: [{ type: "text", text: "Look at this image" }, image],
    });
    const parts = persisted?.content as Array<Record<string, unknown>>;

    expect(parts[0].text).toBe(`${prepared.prependContext}\n\nLook at this image`);
    expect(parts[0].text).not.toContain("memory -- with");
    expect(parts[1]).toBe(image);
  });

  it("starts a fresh frozen snapshot for a new session", () => {
    const ledger = new OpenClawMemoryEpochLedger();
    const first = ledger.prepare({
      sessionKey: "agent:main:test",
      sessionId: "session-1",
      recall: { appendSystemContext: "stable-v1", recallStrategy: "hybrid" },
    });
    ledger.release("agent:main:test");
    const second = ledger.prepare({
      sessionKey: "agent:main:test",
      sessionId: "session-2",
      recall: { appendSystemContext: "stable-v2", recallStrategy: "hybrid" },
    });

    expect(first.prependSystemContext).toBe("stable-v1");
    expect(second.prependSystemContext).toBe("stable-v2");
  });

  it("restores the registry, focus, and epoch after a process restart", () => {
    const firstProcess = new OpenClawMemoryEpochLedger();
    const session = { sessionKey: "agent:main:test", sessionId: "session-1" };
    const first = firstProcess.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory("memory A")],
        recallStrategy: "hybrid",
      },
    });
    const persisted = firstProcess.persist(session.sessionKey, {
      role: "user",
      content: "turn one",
    });

    const secondProcess = new OpenClawMemoryEpochLedger();
    const unchanged = secondProcess.prepare({
      ...session,
      historyMessages: [persisted],
      recall: {
        recalledL1Memories: [memory("memory A")],
        recallStrategy: "hybrid",
      },
    });
    expect(unchanged.memoryEpoch).toBe(1);
    expect(unchanged.prependContext).toBeUndefined();

    const changed = secondProcess.prepare({
      ...session,
      recall: {
        recalledL1Memories: [memory("memory B")],
        recallStrategy: "hybrid",
      },
    });
    expect(changed.memoryEpoch).toBe(2);
    expect(changed.prependContext).toContain("memory B");
    expect(changed.prependContext).toMatch(/focus: [a-f0-9]{12}/);
    expect(first.prependContext).toContain("memory A");
  });
});
