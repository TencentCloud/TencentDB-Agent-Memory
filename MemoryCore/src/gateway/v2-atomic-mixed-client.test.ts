import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TcvdbMemoryStore } from "../core/store/tcvdb/memory-store.js";
import { VectorStore } from "../core/store/sqlite/memory-store.js";
import { handleV2Route, type V2RouterDeps } from "./v2-router.js";

const dirs: string[] = [];
const stores: VectorStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([["sqlite", true], ["sqlite", false], ["vector-db-client-fake", true], ["vector-db-client-fake", false]] as const)("keeps versions monotonic and reports committed response/audit (%s, guarded competitors: %s)", async (backend, guardedCompetitors) => {
  let store: VectorStore | TcvdbMemoryStore;
  if (backend === "sqlite") {
    const dir = mkdtempSync(path.join(tmpdir(), "mixed-cas-"));
    dirs.push(dir);
    store = new VectorStore(path.join(dir, "memory.sqlite"), 0);
    stores.push(store);
    store.init();
    expect(store.isDegraded()).toBe(false);
  } else {
    store = new TcvdbMemoryStore({ url: "https://example.invalid", username: "user", apiKey: "key", database: "test", embeddingEnabled: false, embeddingModel: "none", timeout: 1000 });
    let doc: Record<string, unknown> | undefined;
    // Exercise the real adapter/handler with a deterministic server fake.
    // This models atomic predicates; it is NOT live VectorDB verification.
    const client = {
      upsert: vi.fn(async (_collection, docs) => { doc = { ...docs[0] }; }),
      query: vi.fn(async () => ({ documents: doc ? [{ ...doc }] : [] })),
      update: vi.fn(async (_collection, query, options) => {
        expect(options).toEqual({ maxRetries: 0 });
        const match = /^version = (\d+) and team_id = "team-1" and user_id = "user-1" and agent_id = "agent-1" and task_id = ""$/.exec(query.filter);
        expect(match).not.toBeNull();
        expect(query.documentIds).toEqual(["memory-1"]);
        if (!doc || doc.version !== Number(match![1])) return 0;
        doc = { ...doc, ...query.update };
        return 1;
      }),
    };
    Object.assign(store, { client, _initPromise: Promise.resolve(), degraded: false });
    vi.spyOn(store, "appendAudit").mockResolvedValue(undefined);
  }
  expect(await store.upsertL1({
    id: "memory-1", content: "original", type: "persona", priority: 50,
    scene_name: "default", source_message_ids: [], metadata: {}, timestamps: [],
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    version: 2, sessionKey: "session-key", sessionId: "session-1",
    teamId: "team-1", userId: "user-1", agentId: "agent-1",
  }, undefined)).toBe(true);
  const audit = vi.spyOn(store, "appendAudit");
  const upsert = vi.spyOn(store, "upsertL1");
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { entered = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  const deps: V2RouterDeps = {
    getStore: () => store,
    getEmbedding: () => ({ embed: async (content: string) => {
      if (content === "legacy") { entered(); await resume; }
      return new Float32Array(0);
    } }) as any,
    getStorage: () => undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    deployMode: "standalone",
  };
  async function update(content: string, expected_version?: number) {
    let response: { status: number; body: any } | undefined;
    await handleV2Route(
      { headers: { authorization: "Bearer test-key", "x-tdai-service-id": "service-1" }, url: "/v3/atomic/update" } as any,
      {} as any, "/v3/atomic/update", "POST",
      async <T,>() => ({ team_id: "team-1", user_id: "user-1", agent_id: "agent-1", session_id: "session-1", id: "memory-1", content, ...(expected_version !== undefined ? { expected_version } : {}) }) as T,
      (_res, status, body) => { response = { status, body }; }, deps,
    );
    return response!;
  }
  const legacy = update("legacy");
  await paused;
  expect((await update("competitor-1", guardedCompetitors ? 2 : undefined)).body.data.version).toBe("v3");
  expect((await update("competitor-2", guardedCompetitors ? 3 : undefined)).body.data.version).toBe("v4");
  release();
  const response = await legacy;
  const [persisted] = await store.queryL1Records({ recordIds: ["memory-1"] });
  expect(persisted.content).toBe("legacy");
  expect(persisted.version).toBe(5);
  if (store instanceof VectorStore) {
    expect(store.getCapabilities().ftsSearch).toBe(true);
    expect(store.searchL1Fts("legacy")[0]).toMatchObject({ content: "legacy", version: 5 });
  }
  expect(response.status).toBe(200);
  expect(response.body.data.version).toBe("v5");
  expect(audit.mock.calls.map(([entry]) => entry.version)).toEqual([3, 4, 5]);
  expect(upsert).not.toHaveBeenCalled();
  expect((await update("stale", 3)).status).toBe(409);
  expect((await store.queryL1Records({ recordIds: ["memory-1"] }))[0].content).toBe("legacy");
});
