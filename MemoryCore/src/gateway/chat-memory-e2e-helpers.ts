/**
 * E2E 共享装置：真实 TdaiGateway + SQLite 落盘，用于 chat-memory clear /
 * L0-L1 批量删除的端到端验证。
 *
 * 与 v3-meta.e2e.test.ts 同款做法（真实 HTTP 往返，不 mock store），
 * 抽出来供多个 *.e2e.test.ts 复用。
 */
import { expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiGateway } from "./server.js";

export interface Envelope<T = unknown> {
  code: number;
  message?: string;
  data?: T;
}

export interface E2EContext {
  gateway: TdaiGateway;
  baseUrl: string;
  tmpDir: string;
  gatewayKey: string;
}

let ctx: E2EContext | undefined;

/** 起一个独立实例（独立端口 + 临时数据目录）。 */
export async function startE2EGateway(tag: string): Promise<E2EContext> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tdai-${tag}-e2e-`));
  process.env.TDAI_METADATA_SQLITE_BASE_DIR = path.join(tmpDir, "metadata");
  const gatewayKey = `e2e-${tag}-key`;
  const port = 17000 + Math.floor(Math.random() * 2000);
  const gateway = new TdaiGateway({
    server: { port, host: "127.0.0.1", apiKey: gatewayKey },
    data: { baseDir: tmpDir },
    llm: { baseUrl: "http://localhost:1", apiKey: "test-key", model: "test-model" },
  });
  await gateway.start();
  ctx = { gateway, baseUrl: `http://127.0.0.1:${port}`, tmpDir, gatewayKey };
  return ctx;
}

export async function stopE2EGateway(): Promise<void> {
  if (!ctx) return;
  await ctx.gateway.stop();
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  delete process.env.TDAI_METADATA_SQLITE_BASE_DIR;
  ctx = undefined;
}

export async function post<T = unknown>(
  urlPath: string,
  body: unknown,
  opts: { userKey?: string; noBearer?: boolean } = {},
): Promise<{ status: number; body: Envelope<T> }> {
  if (!ctx) throw new Error("e2e gateway not started");
  const { baseUrl, gatewayKey } = ctx;
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(json)),
    "x-tdai-service-id": "default",
  };
  if (!opts.noBearer) headers.Authorization = `Bearer ${gatewayKey}`;
  if (opts.userKey) headers["x-tdai-user-key"] = opts.userKey;

  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const req = http.request(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Envelope<T> });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: { code: res.statusCode ?? 0, message: raw } });
        }
      });
    });
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}

// ── user / team / agent 装置 ──

let adminKey: string | undefined;

async function seedAdminOnce(): Promise<string> {
  if (adminKey) return adminKey;
  const r = await post<{ user_key?: string; default_user_key?: string }>(
    "/v3/internal/meta/user/init-admin",
    { username: `admin-${Math.random().toString(36).slice(2, 8)}` },
  );
  expect(r.body.code).toBe(0);
  adminKey = r.body.data!.user_key ?? r.body.data!.default_user_key!;
  return adminKey;
}

export interface Fixture {
  userId: string;
  userKey: string;
  teamId: string;
  agentId: string;
  /** chat_memory 资产 id，即需求里的 memory_id。 */
  memoryId: string;
  sessionId: string;
}

/** 建一套 user/team/agent，并写入 L0 消息触发 chat_memory 资产自动登记。 */
export async function makeFixture(tag: string, messageCount = 3): Promise<Fixture> {
  const key = await seedAdminOnce();
  const u = await post<{ user_id: string; default_user_key: string }>(
    "/v3/meta/user/create",
    { username: `u-${tag}-${Math.random().toString(36).slice(2, 6)}` },
    { userKey: key },
  );
  expect(u.body.code).toBe(0);
  const userKey = u.body.data!.default_user_key;

  const t = await post<{ team_id: string }>(
    "/v3/meta/team/create",
    { name: `T-${tag}`, owner_user_id: u.body.data!.user_id },
    { userKey },
  );
  expect(t.body.code).toBe(0);

  const a = await post<{ agent_id: string }>(
    "/v3/meta/agent/create",
    { team_id: t.body.data!.team_id, owner_user_id: u.body.data!.user_id, name: `A-${tag}` },
    { userKey },
  );
  expect(a.body.code).toBe(0);

  const f: Fixture = {
    userId: u.body.data!.user_id,
    userKey,
    teamId: t.body.data!.team_id,
    agentId: a.body.data!.agent_id,
    memoryId: `chat_memory-${t.body.data!.team_id}-${a.body.data!.agent_id}`,
    sessionId: `sess-${tag}-${Date.now()}`,
  };
  if (messageCount > 0) await addMessages(f, messageCount, tag);
  return f;
}

export async function createAgentIn(f: Fixture, tag: string): Promise<Fixture> {
  const a = await post<{ agent_id: string }>(
    "/v3/meta/agent/create",
    { team_id: f.teamId, owner_user_id: f.userId, name: `A-${tag}` },
    { userKey: f.userKey },
  );
  expect(a.body.code).toBe(0);
  return {
    ...f,
    agentId: a.body.data!.agent_id,
    memoryId: `chat_memory-${f.teamId}-${a.body.data!.agent_id}`,
    sessionId: `sess-${tag}-${Date.now()}`,
  };
}

export async function addMessages(
  f: Fixture, count: number, tag: string, sessionId = f.sessionId,
): Promise<string[]> {
  const messages = Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `${tag} message ${i} about project alpha`,
  }));
  const r = await post<{ accepted_ids: string[] }>(
    "/v3/conversation/add",
    { team_id: f.teamId, user_id: f.userId, agent_id: f.agentId, session_id: sessionId, messages },
    { userKey: f.userKey },
  );
  expect(r.body.code).toBe(0);
  return r.body.data!.accepted_ids;
}

/** 统计该 session的 L0 条数。 */
export async function countL0(f: Fixture, sessionId = f.sessionId): Promise<number> {
  const r = await post<{ total: number }>(
    "/v3/conversation/count",
    { team_id: f.teamId, user_id: f.userId, agent_id: f.agentId, session_id: sessionId },
    { userKey: f.userKey },
  );
  expect(r.body.code).toBe(0);
  return r.body.data!.total;
}

/**
 * 列出该 agent 的 L0 消息 id。
 *
 * /v3 严格 isolation 要求请求带 session_id（三元组必填），所以这里必须
 * 逐 session 查询后合并 —— 不能省略 session_id 期望"跨 session 聚合"。
 */
export async function queryL0Ids(f: Fixture, sessionIds: string[] = [f.sessionId]): Promise<string[]> {
  const ids: string[] = [];
  for (const sessionId of sessionIds) {
    const r = await post<{ messages: Array<{ id: string }> }>(
      "/v3/conversation/query",
      { team_id: f.teamId, user_id: f.userId, agent_id: f.agentId, session_id: sessionId, limit: 100 },
      { userKey: f.userKey },
    );
    expect(r.body.code).toBe(0);
    for (const m of r.body.data!.messages ?? []) ids.push(m.id);
  }
  return ids;
}

export async function getAsset(f: Fixture, memoryId = f.memoryId) {
  return post<{
    asset_id: string;
    asset_type: string;
    owner_user_id: string;
    visibility: string;
    team_id: string;
    name?: string;
  }>("/v3/meta/asset/get", { asset_id: memoryId }, { userKey: f.userKey });
}

export async function listAgentFixedAssets(f: Fixture): Promise<string[]> {
  const r = await post<{ items: Array<{ asset_id: string }> }>(
    "/v3/meta/agent-fixed-asset/list",
    { agent_id: f.agentId },
    { userKey: f.userKey },
  );
  expect(r.body.code).toBe(0);
  return (r.body.data!.items ?? []).map((i) => i.asset_id);
}

export async function clearMemories(memoryIds: string[], userKey: string) {
  return post<{
    items: Array<{
      memory_id: string; cleared: boolean;
      l0_deleted: number; l1_deleted: number; profile_deleted: number;
    }>;
    all_cleared: boolean;
  }>("/v3/chat-memory/clear", { memory_ids: memoryIds }, { userKey });
}
