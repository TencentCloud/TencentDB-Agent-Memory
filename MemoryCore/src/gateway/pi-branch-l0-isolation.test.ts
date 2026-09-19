import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VectorStore } from "../core/store/sqlite/memory-store.js";

describe("Pi /tree branch L0 isolation", () => {
  let tempDir: string;
  let store: VectorStore;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "tdai-pi-branch-l0-"));
    store = new VectorStore(path.join(tempDir, "vectors.db"), 0);
    store.init();
  });

  afterAll(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps L0 writes and reads isolated between sibling branches", () => {
    // Pi's adapter derives these canonical values from one base Pi session.
    const baseSessionId = "pi-session-123";
    const branchA = `${baseSessionId}-branch-a`;
    const branchB = `${baseSessionId}-branch-b`;
    const isolation = {
      teamId: "team-pi",
      userId: "user-pi",
      agentId: "agent-pi",
      taskId: "task-pi",
    };

    expect(store.upsertL0(l0Record("branch-a", branchA, "Pi branch A only evidence", isolation), undefined)).toBe(true);
    expect(store.upsertL0(l0Record("branch-b", branchB, "Pi branch B only evidence", isolation), undefined)).toBe(true);

    const fromA = store.queryL0Paginated({ sessionId: branchA, ...isolation, limit: 10, offset: 0 });
    const fromB = store.queryL0Paginated({ sessionId: branchB, ...isolation, limit: 10, offset: 0 });

    expect(fromA.total).toBe(1);
    expect(fromA.rows).toEqual([
      expect.objectContaining({ session_id: branchA, message_text: "Pi branch A only evidence" }),
    ]);
    expect(fromB.total).toBe(1);
    expect(fromB.rows).toEqual([
      expect.objectContaining({ session_id: branchB, message_text: "Pi branch B only evidence" }),
    ]);
  });
});

function l0Record(
  id: string,
  sessionId: string,
  messageText: string,
  isolation: { teamId: string; userId: string; agentId: string; taskId: string },
) {
  return {
    id,
    sessionKey: sessionId,
    sessionId,
    ...isolation,
    role: "assistant",
    messageText,
    recordedAt: "2026-09-19T00:00:00.000Z",
    timestamp: id === "branch-a" ? 1 : 2,
  };
}
