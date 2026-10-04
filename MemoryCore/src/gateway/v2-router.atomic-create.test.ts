import { Readable } from "node:stream";
import type http from "node:http";
import { describe, expect, it } from "vitest";
import type { IMemoryStore, L1RecordRow } from "../core/store/types.js";
import { handleV2Route, type V2RouterDeps } from "./v2-router.js";

const identity = {
  team_id: "team-a",
  agent_id: "agent-a",
  user_id: "user-a",
  session_id: "lifeos-approved-memory",
};

function fixture(initial: L1RecordRow[] = []) {
  const records = [...initial];
  const audits: Array<Record<string, unknown>> = [];
  const writes: unknown[] = [];
  const store = {
    queryL1Records: async ({ recordIds }: { recordIds?: string[] }) =>
      records.filter((row) => !recordIds || recordIds.includes(row.record_id)),
    isFtsAvailable: () => true,
    searchL1Fts: async () => records.map((row) => ({
      record_id: row.record_id,
      content: row.content,
      type: row.type,
      priority: row.priority,
      scene_name: row.scene_name,
      score: 0.9,
      timestamp_str: row.timestamp_str,
      timestamp_start: row.created_time,
      timestamp_end: row.updated_time,
      version: row.version,
      session_key: row.session_key,
      session_id: row.session_id,
      team_id: row.team_id,
      task_id: row.task_id,
      user_id: row.user_id,
      agent_id: row.agent_id,
      metadata_json: row.metadata_json,
    })),
    upsertL1: async (record: Record<string, unknown>) => {
      writes.push(record);
      records.push({
        record_id: String(record.id),
        content: String(record.content),
        type: String(record.type),
        priority: Number(record.priority),
        scene_name: String(record.scene_name),
        session_key: String(record.sessionKey),
        session_id: String(record.sessionId),
        team_id: String(record.teamId),
        task_id: String(record.taskId ?? ""),
        user_id: String(record.userId),
        agent_id: String(record.agentId),
        version: Number(record.version),
        timestamp_str: "",
        timestamp_start: "",
        timestamp_end: "",
        created_time: String(record.createdAt),
        updated_time: String(record.updatedAt),
        metadata_json: JSON.stringify(record.metadata),
      });
      return true;
    },
    createL1: async (record: Record<string, unknown>) => {
      writes.push(record);
      if (records.some((row) => row.record_id === record.id)) return false;
      records.push({
        record_id: String(record.id),
        content: String(record.content),
        type: String(record.type),
        priority: Number(record.priority),
        scene_name: String(record.scene_name),
        session_key: String(record.sessionKey),
        session_id: String(record.sessionId),
        team_id: String(record.teamId),
        task_id: String(record.taskId ?? ""),
        user_id: String(record.userId),
        agent_id: String(record.agentId),
        version: Number(record.version),
        timestamp_str: "",
        timestamp_start: "",
        timestamp_end: "",
        created_time: String(record.createdAt),
        updated_time: String(record.updatedAt),
        metadata_json: JSON.stringify(record.metadata),
      });
      return true;
    },
    appendAudit: async (entry: Record<string, unknown>) => { audits.push(entry); },
  } as unknown as IMemoryStore;
  const deps: V2RouterDeps = {
    getStore: () => store,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    deployMode: "standalone",
  };
  return { records, audits, writes, deps };
}

async function postRoute(deps: V2RouterDeps, pathname: string, body: Record<string, unknown>, expectedHandled = true) {
  const req = Readable.from([JSON.stringify(body)]) as Readable & { headers: Record<string, string>; url: string };
  req.headers = {
    authorization: "Bearer test-token",
    "x-tdai-service-id": "test-service",
  };
  req.url = pathname;
  const res = {} as http.ServerResponse;
  let response: { status: number; body: Record<string, unknown> } | undefined;
  const handled = await handleV2Route(
    req as never,
    res,
    pathname,
    "POST",
    async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    },
    (_res, status, result) => { response = { status, body: result as Record<string, unknown> }; },
    deps,
  );
  expect(handled).toBe(expectedHandled);
  return response!;
}

const postCreate = (deps: V2RouterDeps, body: Record<string, unknown>) =>
  postRoute(deps, "/v3/atomic/create", body);

describe("POST /v3/atomic/create", () => {
  it("does not expose create through the relaxed v2 route table", async () => {
    const f = fixture();
    const result = await postRoute(f.deps, "/v2/atomic/create", {
      ...identity,
      id: "lifeos-memory-1",
      type: "persona",
      content: "Prefers concise answers",
    }, false);

    expect(result).toBeUndefined();
    expect(f.writes).toHaveLength(0);
  });

  it("creates an approved atom, audits it, and makes an identical retry idempotent", async () => {
    const f = fixture();
    const metadata = { source: "lifeos", source_ref: "reflection:42", approval_ref: "approval:9" };
    const body = { ...identity, id: "lifeos-memory-1", type: "persona", content: "Prefers concise answers", background: "weekly review", metadata };

    const first = await postCreate(f.deps, body);
    const replay = await postCreate(f.deps, body);

    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ id: body.id, version: 1, created: true });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({ id: body.id, version: 1, created: false });
    expect(f.writes).toHaveLength(1);
    expect(f.records[0].metadata_json).toBe(JSON.stringify(metadata));
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]).toMatchObject({ action: "create", record_id: body.id, user_id: identity.user_id });

    const queried = await postRoute(f.deps, "/v3/atomic/query", { ...identity });
    expect(queried.status).toBe(200);
    expect((queried.body.data as { items: Array<{ metadata: Record<string, unknown> }> }).items[0].metadata).toEqual(metadata);

    const searched = await postRoute(f.deps, "/v3/atomic/search", { ...identity, query: "concise answers" });
    expect(searched.status).toBe(200);
    expect((searched.body.data as { items: Array<{ metadata: Record<string, unknown> }> }).items[0].metadata).toEqual(metadata);
  });

  it("rejects changed payloads and cross-tenant reuse without overwriting", async () => {
    const f = fixture();
    const body = { ...identity, id: "lifeos-memory-1", type: "persona", content: "Original", background: "" };
    await postCreate(f.deps, body);

    const changed = await postCreate(f.deps, { ...body, metadata: { approval_ref: "different" } });
    const foreign = await postCreate(f.deps, { ...body, user_id: "other-user", content: "Original" });

    expect(changed.status).toBe(409);
    expect(foreign.status).toBe(404);
    expect(f.writes).toHaveLength(1);
  });

  it("resolves a simultaneous same-ID race through the store's insert-only result", async () => {
    const f = fixture();
    const body = { ...identity, id: "lifeos-memory-race", type: "persona", content: "Same approved memory" };
    const [first, second] = await Promise.all([postCreate(f.deps, body), postCreate(f.deps, body)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect([first.body.data, second.body.data]).toContainEqual(expect.objectContaining({ created: true }));
    expect([first.body.data, second.body.data]).toContainEqual(expect.objectContaining({ created: false }));
    expect(f.records).toHaveLength(1);
    expect(f.audits).toHaveLength(1);
  });

  it("never overwrites when concurrent callers race with different payloads", async () => {
    const f = fixture();
    const base = { ...identity, id: "lifeos-memory-conflict-race", type: "persona" };
    const [first, second] = await Promise.all([
      postCreate(f.deps, { ...base, content: "Payload A" }),
      postCreate(f.deps, { ...base, content: "Payload B" }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(f.records).toHaveLength(1);
    expect(["Payload A", "Payload B"]).toContain(f.records[0].content);
    expect(f.audits).toHaveLength(1);
  });

  it("does not require a Gateway lock because uniqueness is enforced by the store", async () => {
    const f = fixture();
    const deps = { ...f.deps, stateBackend: undefined };
    const result = await postCreate(deps, {
      ...identity,
      id: "lifeos-memory-1",
      type: "persona",
      content: "Prefers concise answers",
    });

    expect(result.status).toBe(200);
    expect(f.writes).toHaveLength(1);
  });

  it("fails closed when the selected backend has no atomic create capability", async () => {
    const f = fixture();
    const storeWithoutCreate = { ...f.deps.getStore(), createL1: undefined };
    const deps = { ...f.deps, getStore: () => storeWithoutCreate as IMemoryStore };
    const result = await postCreate(deps, {
      ...identity,
      id: "lifeos-memory-1",
      type: "persona",
      content: "Prefers concise answers",
    });

    expect(result.status).toBe(501);
    expect(f.writes).toHaveLength(0);
  });

  it("fails closed when a backend explicitly disables atomic create", async () => {
    const f = fixture();
    const store = { ...f.deps.getStore(), supportsAtomicL1Create: false };
    const deps = { ...f.deps, getStore: () => store as IMemoryStore };
    const result = await postCreate(deps, {
      ...identity,
      id: "lifeos-memory-1",
      type: "persona",
      content: "Prefers concise answers",
    });

    expect(result.status).toBe(501);
    expect(f.writes).toHaveLength(0);
  });
});
