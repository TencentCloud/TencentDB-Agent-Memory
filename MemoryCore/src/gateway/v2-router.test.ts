import { describe, expect, it, vi } from "vitest";
import type http from "node:http";

import type { IsolationFilter, IMemoryStore } from "../core/store/types.js";
import type { Logger } from "../types.js";
import { handleV2Route, type V2RouterDeps } from "./v2-router.js";

// ── Test helpers ──

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function makeReq(headers: Record<string, string>): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

function makeSend(): {
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  last: () => { status: number; body: any };
} {
  const state = { status: 0, body: undefined as unknown };
  return {
    sendJson: (_res: http.ServerResponse, status: number, body: unknown) => {
      state.status = status;
      state.body = body;
    },
    last: () => state as { status: number; body: any },
  };
}

interface StoredRecord {
  recordId: string;
  sessionId: string;
  userId: string;
  agentId: string;
  teamId?: string;
}

/**
 * Mock IMemoryStore whose deleteL0/deleteL0BySession emulate
 * rowMatchesIsolation (isolation.ts): an unset filter dimension is skipped,
 * a set dimension must equal the record. This is what turns the pre-fix
 * "default" sessionId placeholder into a silent no-op (#871).
 */
function makeStore(record: StoredRecord): {
  store: IMemoryStore;
  deleteCalls: (IsolationFilter | undefined)[];
} {
  const deleteCalls: (IsolationFilter | undefined)[] = [];

  const deleteL0 = vi.fn(async (recordId: string, filter?: IsolationFilter): Promise<boolean> => {
    deleteCalls.push(filter);
    if (recordId !== record.recordId) return false;
    if (filter?.sessionId !== undefined && filter.sessionId !== record.sessionId) return false;
    if (filter?.userId !== undefined && filter.userId !== record.userId) return false;
    if (filter?.agentId !== undefined && filter.agentId !== record.agentId) return false;
    if (filter?.teamId !== undefined && filter.teamId !== record.teamId) return false;
    return true;
  });

  const deleteL0BySession = vi.fn(async (sessionId: string, filter?: IsolationFilter): Promise<number> => {
    deleteCalls.push(filter);
    if (sessionId !== record.sessionId) return 0;
    if (filter?.userId !== undefined && filter.userId !== record.userId) return 0;
    if (filter?.agentId !== undefined && filter.agentId !== record.agentId) return 0;
    return 1;
  });

  return { store: { deleteL0, deleteL0BySession } as unknown as IMemoryStore, deleteCalls };
}

function makeDeps(store: IMemoryStore): V2RouterDeps {
  return {
    getStore: () => store,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    logger,
    deployMode: "standalone",
  } as V2RouterDeps;
}

/** Drive POST /v2/conversation/delete through the real dispatch path. */
async function deleteVia(
  body: Record<string, unknown>,
  deps: V2RouterDeps,
): Promise<{ status: number; body: any }> {
  const send = makeSend();
  const res = {} as http.ServerResponse;
  await handleV2Route(
    makeReq({ authorization: "Bearer test-key", "x-tdai-service-id": "svc-test" }),
    res,
    "/v2/conversation/delete",
    "POST",
    async () => body,
    send.sendJson,
    deps,
  );
  return send.last();
}

// ── Tests ──

const record: StoredRecord = {
  recordId: "rec-1",
  sessionId: "session-real",
  userId: "user-1",
  agentId: "agent-1",
  teamId: "team-1",
};

describe("conversation delete isolation (#871)", () => {
  it("message_ids-only delete removes a record stored under a real session", async () => {
    const { store, deleteCalls } = makeStore(record);
    const res = await deleteVia(
      { message_ids: ["rec-1"], user_id: "user-1", agent_id: "agent-1", team_id: "team-1" },
      makeDeps(store),
    );

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.deleted_count).toBe(1);
    // The fix: sessionId is not propagated (the request carried none, so
    // resolveIsolation would have filled the "default" placeholder).
    expect(deleteCalls[0]).not.toHaveProperty("sessionId");
  });

  it("session_id path still works with the same tenant scoping", async () => {
    const { store } = makeStore(record);
    const res = await deleteVia(
      { session_id: "session-real", user_id: "user-1", agent_id: "agent-1", team_id: "team-1" },
      makeDeps(store),
    );

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.deleted_count).toBe(1);
  });

  it("still refuses to delete a record owned by a different user", async () => {
    const { store } = makeStore(record);
    const res = await deleteVia(
      { message_ids: ["rec-1"], user_id: "user-2", agent_id: "agent-1", team_id: "team-1" },
      makeDeps(store),
    );

    expect(res.status).toBe(200);
    expect(res.body.data.deleted_count).toBe(0);
  });
});
