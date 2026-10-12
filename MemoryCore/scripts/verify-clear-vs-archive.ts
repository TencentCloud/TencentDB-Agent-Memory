/**
 * 开发机验证脚本：对比「删除 Agent」与「clear 清空」对 chat_memory 资产的影响。
 *
 * 目的是把面板当前行为的问题坐实（而不是只看代码推断）：
 *   场景 A —— archiveAgent（面板 /api/v1/agent/delete-cascade 最终调用的内核动作）
 *             会把 chat_memory 资产**整个删掉**，Agent 想继续用必须重建+ 重新绑定。
 *   场景 B —— /v3/chat-memory/clear 只清内容，资产 / 绑定 / 可见性全部保留，
 *             清完可以直接继续写入。
 *
 * 用法（在MemoryCore 目录下）：
 *   node --import tsx scripts/verify-clear-vs-archive.ts
 *
 * 只读+ 自建临时数据，不连任何线上资源；跑完自动清理临时目录。
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TdaiGateway } from "../src/gateway/server.js";

const GATEWAY_KEY = "verify-clear-key";
const PORT = 19300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

interface Envelope<T = unknown> {
  code: number;
  message?: string;
  data?: T;
}

function post<T = unknown>(
  urlPath: string,
  body: unknown,
  userKey?: string,
): Promise<{ status: number; body: Envelope<T> }> {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(json)),
    "x-tdai-service-id": "default",
    Authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (userKey) headers["x-tdai-user-key"] = userKey;

  return new Promise((resolve, reject) => {
    const req = http.request(new URL(urlPath, BASE), { method: "POST", headers }, (res) => {
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

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

async function must<T>(label: string, p: Promise<{ status: number; body: Envelope<T> }>): Promise<T> {
  const r = await p;
  if (r.body.code !== 0) {
    throw new Error(`${label} failed: code=${r.body.code} msg=${r.body.message}`);
  }
  return r.body.data as T;
}

interface Ctx {
  userId: string;
  userKey: string;
  teamId: string;
  agentId: string;
  memoryId: string;
  sessionId: string;
}

async function setup(adminKey: string, tag: string): Promise<Ctx> {
  const u = await must<{ user_id: string; default_user_key: string }>(
    "user/create",
    post("/v3/meta/user/create", { username: `u-${tag}-${Date.now().toString(36)}` }, adminKey),
  );
  const t = await must<{ team_id: string }>(
    "team/create",
    post("/v3/meta/team/create", { name: `T-${tag}`, owner_user_id: u.user_id }, u.default_user_key),
  );
  const a = await must<{ agent_id: string }>(
    "agent/create",
    post(
      "/v3/meta/agent/create",
      { team_id: t.team_id, owner_user_id: u.user_id, name: `A-${tag}` },
      u.default_user_key,
    ),
  );
  const ctx: Ctx = {
    userId: u.user_id,
    userKey: u.default_user_key,
    teamId: t.team_id,
    agentId: a.agent_id,
    memoryId: `chat_memory-${t.team_id}-${a.agent_id}`,
    sessionId: `s-${tag}-${Date.now()}`,
  };
  await addMsgs(ctx, 3);
  return ctx;
}

async function addMsgs(c: Ctx, n: number) {
  return must<{ accepted_ids: string[] }>(
    "conversation/add",
    post(
      "/v3/conversation/add",
      {
        team_id: c.teamId, user_id: c.userId, agent_id: c.agentId, session_id: c.sessionId,
        messages: Array.from({ length: n }, (_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `msg ${i} for ${c.agentId}`,
        })),
      },
      c.userKey,
    ),
  );
}

async function countL0(c: Ctx): Promise<number> {
  const d = await must<{ total: number }>(
    "conversation/count",
    post(
      "/v3/conversation/count",
      { team_id: c.teamId, user_id: c.userId, agent_id: c.agentId, session_id: c.sessionId },
      c.userKey,
    ),
  );
  return d.total;
}

async function assetStatus(c: Ctx): Promise<{ exists: boolean; code: number }> {
  const r = await post("/v3/meta/asset/get", { asset_id: c.memoryId }, c.userKey);
  return { exists: r.body.code === 0 && !!r.body.data, code: r.body.code };
}

async function bindings(c: Ctx): Promise<string[]> {
  const r = await post<{ items: Array<{ asset_id: string }> }>(
    "/v3/meta/agent-fixed-asset/list",
    { agent_id: c.agentId },
    c.userKey,
  );
  if (r.body.code !== 0) return [];
  return (r.body.data?.items ?? []).map((i) => i.asset_id);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-clear-"));
  process.env.TDAI_METADATA_SQLITE_BASE_DIR = path.join(tmpDir, "metadata");

  const gateway = new TdaiGateway({
    server: { port: PORT, host: "127.0.0.1", apiKey: GATEWAY_KEY },
    data: { baseDir: tmpDir },
    llm: { baseUrl: "http://localhost:1", apiKey: "test-key", model: "test-model" },
  });
  await gateway.start();

  try {
    const admin = await must<{ user_key?: string; default_user_key?: string }>(
      "init-admin",
      post("/v3/internal/meta/user/init-admin", { username: `admin-${Date.now().toString(36)}` }),
    );
    const adminKey = admin.user_key ?? admin.default_user_key!;

    // ── 场景 A：删除 Agent（面板 delete-cascade 的最终动作）──
    console.log("\n场景 A — agent/archive（删除 Agent：应连带删除该 agent 的 memory 内容）");
    const a = await setup(adminKey, "archive");
    check("前置：memory 资产存在", (await assetStatus(a)).exists);
    check("前置：绑定存在", (await bindings(a)).includes(a.memoryId));
    check("前置：L0 有 3 条", (await countL0(a)) === 3);

    await must("agent/archive", post("/v3/meta/agent/archive", { agent_id: a.agentId }, a.userKey));

    const aAfter = await assetStatus(a);
    check("删 Agent 后 memory 资产被删除", !aAfter.exists, `asset/get code=${aAfter.code}`);

    // 关键回归点：修复前这里会残留 3 条（资产没了但内容还在 → 永久孤儿数据）
    const aL0 = await countL0(a);
    check("删 Agent 后该 agent 的 memory 内容也被清零（无孤儿数据）", aL0 === 0, `实际残留 ${aL0} 条`);

    // ── 场景 B：clear（新接口）──
    console.log("\n场景 B — /v3/chat-memory/clear（新接口）");
    const b = await setup(adminKey, "clear");
    const beforeAsset = await post<{ visibility: string; owner_user_id: string; name?: string }>(
      "/v3/meta/asset/get", { asset_id: b.memoryId }, b.userKey,
    );
    check("前置：memory 资产存在", beforeAsset.body.code === 0);
    check("前置：L0 有 3 条", (await countL0(b)) === 3);

    const cleared = await must<{
      items: Array<{ memory_id: string; cleared: boolean; l0_deleted: number }>;
      all_cleared: boolean;
    }>("chat-memory/clear", post("/v3/chat-memory/clear", { memory_ids: [b.memoryId] }, b.userKey));

    check("clear 返回 all_cleared=true", cleared.all_cleared === true);
    check("clear 删除了 3 条 L0", cleared.items[0].l0_deleted === 3, `实际 ${cleared.items[0].l0_deleted}`);
    check("清空后 L0 归零", (await countL0(b)) === 0);
    check("清空后 memory 资产仍存在", (await assetStatus(b)).exists);
    check("清空后 Agent 绑定仍在", (await bindings(b)).includes(b.memoryId));

    const afterAsset = await post<{ visibility: string; owner_user_id: string; name?: string }>(
      "/v3/meta/asset/get", { asset_id: b.memoryId }, b.userKey,
    );
    check(
      "清空后 Owner / 可见性 / 名称不变",
      afterAsset.body.data?.owner_user_id === beforeAsset.body.data?.owner_user_id
      && afterAsset.body.data?.visibility === beforeAsset.body.data?.visibility
      && afterAsset.body.data?.name === beforeAsset.body.data?.name,
    );

    // 清完继续写入，不需要重建
    await addMsgs(b, 2);
    check("清空后可直接继续写入原 memory_id", (await countL0(b)) === 2);

    // 幂等
    const again = await must<{ items: Array<{ cleared: boolean; l0_deleted: number }> }>(
      "chat-memory/clear 再次",
      post("/v3/chat-memory/clear", { memory_ids: [b.memoryId] }, b.userKey),
    );
    check("重复 clear 幂等成功", again.items[0].cleared === true);

    console.log(`\n结果：${pass} passed, ${fail} failed\n`);
  } finally {
    await gateway.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TDAI_METADATA_SQLITE_BASE_DIR;
  }

  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("verify crashed:", err);
  process.exitCode = 1;
});
