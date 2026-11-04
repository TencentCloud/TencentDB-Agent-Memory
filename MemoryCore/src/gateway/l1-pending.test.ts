/**
 * Tests for the stranded-backlog guard helper (#l1-stranding incident, 2026-09-17).
 *
 * The guard's whole point: `conversation_count === 0` must not be trusted as
 * "nothing pending" — only the L0 store can say that. These tests pin the
 * helper's existence semantics (presence/absence after cursor) and that the
 * cursor and limit are forwarded to the store query unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import { countPendingL0Rows } from "./l1-pending.js";
import type { IMemoryStore, L0SessionGroup } from "../core/store/types.js";

function fakeStore(groups: L0SessionGroup[]) {
  const queryL0GroupedBySessionId = vi.fn(async () => groups);
  return {
    store: { queryL0GroupedBySessionId } as unknown as Pick<IMemoryStore, "queryL0GroupedBySessionId">,
    queryL0GroupedBySessionId,
  };
}

function group(sessionId: string, messageCount: number): L0SessionGroup {
  return {
    sessionId,
    messages: Array.from({ length: messageCount }, (_, i) => ({
      id: `msg_${i}`,
      role: "user" as const,
      content: `c${i}`,
      timestamp: 1000 + i,
      recordedAtMs: 2000 + i,
    })),
  } as unknown as L0SessionGroup;
}

describe("countPendingL0Rows — stranded-backlog guard", () => {
  it("counts rows across groups (presence check)", async () => {
    const { store } = fakeStore([group("s1", 2), group("s2", 1)]);
    expect(await countPendingL0Rows(store, "s1", 1234)).toBe(3);
  });

  it("returns 0 when the store reports nothing past the cursor", async () => {
    const { store } = fakeStore([]);
    expect(await countPendingL0Rows(store, "s1", 1234)).toBe(0);
  });

  it("forwards the cursor as afterRecordedAtMs and defaults limit to 1", async () => {
    const { store, queryL0GroupedBySessionId } = fakeStore([]);
    await countPendingL0Rows(store, "sess-x", 987654);
    expect(queryL0GroupedBySessionId).toHaveBeenCalledWith("sess-x", 987654, 1, { throwOnError: true });
  });

  it("passes undefined for a never-distilled session (cursor 0 upstream)", async () => {
    const { store, queryL0GroupedBySessionId } = fakeStore([]);
    await countPendingL0Rows(store, "sess-new", undefined, 5);
    expect(queryL0GroupedBySessionId).toHaveBeenCalledWith("sess-new", undefined, 5, { throwOnError: true });
  });

  it("propagates a store query failure instead of reading it as zero pending", async () => {
    const queryL0GroupedBySessionId = vi.fn(async () => {
      throw new Error("db temporarily unavailable");
    });
    const store = { queryL0GroupedBySessionId } as unknown as Pick<
      IMemoryStore,
      "queryL0GroupedBySessionId"
    >;
    // A swallowed failure here would skip the timer-fired L1 and strand the
    // backlog — the guard must surface the error to the retry path instead.
    await expect(countPendingL0Rows(store, "s1", 1234)).rejects.toThrow("db temporarily unavailable");
  });
});
