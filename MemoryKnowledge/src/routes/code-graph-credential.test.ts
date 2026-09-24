/**
 * code-graph ↔ credential_id 联动：路由校验 + 幂等 create 换绑。
 *
 * 守住上轮 CR 的两点：
 *   1. 幂等 create 传入新 credential_id 时必须写入（不能静默丢掉）
 *   2. create / update-meta 的 host 绑定校验同强度
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDb } from "../db/client.js";
import {
  CodeGraphService,
  SqliteKnowledgeStore,
  createGitCredentialStore,
  genGitCredentialId,
  type IGitCredentialStore,
} from "../store/index.js";
import { createCodeGraphRoutes, type CodeGraphRouteDeps } from "./code-graph.js";

const SECRET_KEY = "k".repeat(48);
const SERVICE = "svc-A";
const TEAM = "team-1";
const REPO = "https://git.example.com/group/repo.git";
const TOKEN = "ghp_TESTTOKEN1234567890";

let app: Hono;
let credentialStore: IGitCredentialStore;
let cgService: CodeGraphService;
let workerCalls: Array<{ credentialId: string | null }>;

function buildApp() {
  const { db } = createDb({ path: ":memory:" });
  const store = new SqliteKnowledgeStore(db);
  credentialStore = createGitCredentialStore({ db, secretKey: SECRET_KEY });
  workerCalls = [];
  cgService = new CodeGraphService({
    store,
    dataRoot: mkdtempSync(join(tmpdir(), "kg-cg-")),
    worker: async (ctx) => {
      workerCalls.push({ credentialId: ctx.credentialId });
      return { commitHash: "abc123", stats: { files: 1, nodes: 1, edges: 0 } };
    },
  });

  const deps: CodeGraphRouteDeps = {
    cgService,
    instancePool: {
      get: () => undefined,
      set: () => {},
      delete: () => {},
    },
    publicBaseUrl: "http://127.0.0.1:8421/v3",
    credentialStore,
  };

  const hono = new Hono();
  hono.route("/code-graph", createCodeGraphRoutes(deps));
  return hono;
}

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": SERVICE,
    },
    body: JSON.stringify(body),
  });
}

async function json(res: Response) {
  return (await res.json()) as { code: number; message: string; data: any };
}

function seedCredential(host = "git.example.com") {
  return credentialStore.create({
    credential_id: genGitCredentialId(),
    service_id: SERVICE,
    team_id: TEAM,
    name: `pat-${host}`,
    kind: "https_token",
    host,
    username: "oauth2",
    secret: TOKEN,
    created_by: "user-1",
  });
}

beforeEach(() => {
  app = buildApp();
});

describe("POST /code-graph/create + credential_id", () => {
  it("新建时绑定 credential_id", async () => {
    const cred = seedCredential();
    const res = await post("/code-graph/create", {
      team_id: TEAM,
      repo_url: REPO,
      branch: "main",
      credential_id: cred.credential_id,
    });
    const body = await json(res);
    expect(res.status).toBe(201);
    expect(body.data.credential_id).toBe(cred.credential_id);
  });

  it("幂等 create：已存在行写入本次 credential_id（根因复现）", async () => {
    // 先匿名创建（例如 UI 首次点了公开仓流程，或私有仓误建）
    const first = await json(
      await post("/code-graph/create", {
        team_id: TEAM,
        repo_url: REPO,
        branch: "main",
      }),
    );
    expect(first.data.credential_id).toBeNull();
    const cgId = first.data.code_graph_id as string;

    // 等第一轮 worker 跑完（失败/成功都行），模拟「再 create 一次并带凭证」
    await vi.waitFor(() => {
      const row = cgService.getById(SERVICE, cgId);
      expect(row?.status === "ready" || row?.status === "failed").toBe(true);
    });

    const cred = seedCredential();
    const secondRes = await post("/code-graph/create", {
      team_id: TEAM,
      repo_url: REPO,
      branch: "main",
      credential_id: cred.credential_id,
    });
    const second = await json(secondRes);
    expect(secondRes.status).toBe(200);
    expect(second.data.code_graph_id).toBe(cgId);
    // 关键断言：不能仍是 null / 旧值
    expect(second.data.credential_id).toBe(cred.credential_id);

    // 换绑后应重新入队，worker 看到新凭证
    await vi.waitFor(() => {
      expect(workerCalls.some((c) => c.credentialId === cred.credential_id)).toBe(true);
    });
  });

  it("幂等 create 不传 credential_id 时不覆盖已有绑定", async () => {
    const cred = seedCredential();
    const first = await json(
      await post("/code-graph/create", {
        team_id: TEAM,
        repo_url: REPO,
        branch: "main",
        credential_id: cred.credential_id,
      }),
    );
    expect(first.data.credential_id).toBe(cred.credential_id);

    const second = await json(
      await post("/code-graph/create", {
        team_id: TEAM,
        repo_url: REPO,
        branch: "main",
      }),
    );
    expect(second.data.credential_id).toBe(cred.credential_id);
  });

  it("credential host 与 repo_url 不一致 → 404", async () => {
    const cred = seedCredential("evil.example.com");
    const res = await post("/code-graph/create", {
      team_id: TEAM,
      repo_url: REPO,
      branch: "main",
      credential_id: cred.credential_id,
    });
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.message).toMatch(/bound to evil\.example\.com/i);
  });

  it("跨 team 的 credential_id → 404", async () => {
    const cred = credentialStore.create({
      credential_id: genGitCredentialId(),
      service_id: SERVICE,
      team_id: "other-team",
      name: "other",
      kind: "https_token",
      host: "git.example.com",
      username: "oauth2",
      secret: TOKEN,
      created_by: "user-1",
    });
    const res = await post("/code-graph/create", {
      team_id: TEAM,
      repo_url: REPO,
      branch: "main",
      credential_id: cred.credential_id,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /code-graph/update-meta + credential_id", () => {
  it("换绑校验强度与 create 一致（host mismatch → 404）", async () => {
    const created = await json(
      await post("/code-graph/create", {
        team_id: TEAM,
        repo_url: REPO,
        branch: "main",
      }),
    );
    const cred = seedCredential("evil.example.com");
    const res = await post("/code-graph/update-meta", {
      code_graph_id: created.data.code_graph_id,
      credential_id: cred.credential_id,
    });
    expect(res.status).toBe(404);
  });

  it("换绑成功写入 credential_id；null 解绑", async () => {
    const created = await json(
      await post("/code-graph/create", {
        team_id: TEAM,
        repo_url: REPO,
        branch: "main",
      }),
    );
    const cgId = created.data.code_graph_id as string;
    const cred = seedCredential();

    const bound = await json(
      await post("/code-graph/update-meta", {
        code_graph_id: cgId,
        credential_id: cred.credential_id,
      }),
    );
    expect(bound.data.credential_id).toBe(cred.credential_id);

    const unbound = await json(
      await post("/code-graph/update-meta", {
        code_graph_id: cgId,
        credential_id: null,
      }),
    );
    expect(unbound.data.credential_id).toBeNull();
  });
});
