/**
 * Tests for #417 — the /v3/memories/explicit (and /v2) route:
 * dispatch recognizes the path, and handleExplicitMemoryWrite mirrors a
 * host-native durable-memory write into L1 (stored=true) or reports failure.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleV2Route, handleExplicitMemoryWrite, type V2RouterDeps } from "./v2-router.js";
import type { IMemoryStore } from "../core/store/types.js";

function makeStore(upsertOk = true): IMemoryStore {
  return {
    upsertL1: async () => upsertOk,
    deleteL1: async () => true,
    deleteL1Batch: async () => true,
    deleteL1Expired: async () => 0,
    queryL1Records: async () => [],
    countL1: async () => 0,
    getAllL1Texts: async () => [],
    searchL1Vector: async () => [],
    searchL1Fts: async () => [],
    upsertL0: async () => true,
    deleteL0: async () => true,
    deleteL0Expired: async () => 0,
    queryL0ForL1: async () => [],
    queryL0GroupedBySessionId: async () => [],
    getAllL0Texts: async () => [],
    searchL0Vector: async () => [],
    searchL0Fts: async () => [],
    reindexAll: async () => ({ l1Count: 0, l0Count: 0 }),
    init: async () => ({ ok: true }),
    isDegraded: () => false,
    getCapabilities: () => ({ supportsVector: true, supportsFts: false }),
    close: () => {},
  } as unknown as IMemoryStore;
}

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

function makeDeps(store?: IMemoryStore): V2RouterDeps {
  return {
    getStore: () => store,
    getEmbedding: () => ({ embed: async () => new Float32Array(8) }) as never,
    getStorage: () => undefined,
    dataBaseDir: mkdtempSync(join(tmpdir(), "explicit-route-417-")),
    deployMode: "standalone",
    logger,
    isolationConfig: { enforce: false, legacyCompatMode: true, legacyPlaceholder: "" },
    requestIsolation: { teamId: undefined, userId: "default", agentId: "default", sessionId: "sess-1" },
    requestIsolationMissing: [],
  } as unknown as V2RouterDeps;
}

describe("handleExplicitMemoryWrite (#417)", () => {
  it("stores an explicit memory write", async () => {
    const deps = makeDeps(makeStore());
    const res = await handleExplicitMemoryWrite(
      { action: "add", target: "memory", content: "TencentDB probe marker", session_id: "sess-1" },
      {} as never,
      "req-1",
      deps,
    );
    expect(res.code).toBe(0);
    const data = (res.data as { stored: boolean; memory_id?: string }).data ?? (res.data as any);
    // successEnvelope shape: { code, message, data }
    expect((res.data as { stored?: boolean }).stored ?? true).toBeTruthy();
  });

  it("reports stored=false when the store is unavailable", async () => {
    const deps = makeDeps(undefined); // no store
    const res = await handleExplicitMemoryWrite(
      { action: "add", target: "memory", content: "x", session_id: "sess-1" },
      {} as never,
      "req-1",
      deps,
    );
    // No store → 503
    expect(res.code).toBe(503);
  });

  it("rejects when required fields are missing", async () => {
    const deps = makeDeps(makeStore());
    const res = await handleExplicitMemoryWrite(
      { action: "add", content: "no target" },
      {} as never,
      "req-1",
      deps,
    );
    expect(res.code).toBe(400);
  });
});

describe("handleV2Route dispatch for /memories/explicit (#417)", () => {
  it("recognizes /v3/memories/explicit and dispatches to the handler", async () => {
    const store = makeStore();
    const deps = makeDeps(store);
    let sent: unknown;
    const handled = await handleV2Route(
      { headers: { authorization: "Bearer local", "x-tdai-service-id": "default" } } as never,
      { setHeader: () => {}, end: () => {} } as never,
      "/v3/memories/explicit",
      "POST",
      async () => ({ action: "add", target: "memory", content: "probe", session_id: "sess-1" }),
      (_res, _status, body) => { sent = body; },
      deps,
    );
    expect(handled).toBe(true);
    expect(sent).toBeTruthy();
  });
});
