import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDb } from "../db/client.js";
import { createGitCredentialStore, type IGitCredentialStore } from "../store/index.js";
import { createSourceCredentialRoutes, type SourceCredentialRouteDeps } from "./source-credential.js";

const SECRET_KEY = "k".repeat(48);
const SERVICE = "svc-A";
const TEAM = "team-1";
const TOKEN = "ghp_TESTTOKEN1234567890";

let app: Hono;
let credentialStore: IGitCredentialStore;
let deps: SourceCredentialRouteDeps;

function buildApp(overrides: Partial<SourceCredentialRouteDeps> = {}) {
  const { db } = createDb({ path: ":memory:" });
  credentialStore = createGitCredentialStore({ db, secretKey: SECRET_KEY });
  deps = {
    credentialStore,
    configured: true,
    validateRepoUrl: vi.fn(),
    probeRemote: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  const hono = new Hono();
  hono.route("/source-credential", createSourceCredentialRoutes(deps));
  return hono;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-service-id": SERVICE, ...headers },
    body: JSON.stringify(body),
  });
}

async function json(res: Response) {
  return (await res.json()) as { code: number; message: string; data: any };
}

async function createCredential(overrides: Record<string, unknown> = {}) {
  const res = await post("/source-credential/create", {
    team_id: TEAM,
    name: "gitlab-pat",
    kind: "https_token",
    host: "git.example.com",
    secret: TOKEN,
    user_id: "user-1",
    ...overrides,
  });
  return { res, body: await json(res) };
}

beforeEach(() => {
  app = buildApp();
});

describe("POST /create", () => {
  it("创建成功返回掩码 detail，响应体里没有密钥", async () => {
    const { res, body } = await createCredential();
    expect(res.status).toBe(201);
    expect(body.data.credential_id).toMatch(/^gc-[0-9a-z]{8}$/);
    expect(body.data.host).toBe("git.example.com");
    expect(body.data.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(body.data.secret).toBeUndefined();
    expect(body.data.secret_enc).toBeUndefined();
  });

  it("缺 x-tdai-service-id / team_id → 400", async () => {
    expect((await post("/source-credential/create", { team_id: TEAM }).then(json)).code).toBe(400);
    const noTeam = await post("/source-credential/create", { }, { "x-tdai-service-id": SERVICE });
    expect((await json(noTeam)).code).toBe(400);
  });

  it("name / kind / host / secret 缺失或非法 → 400", async () => {
    expect((await createCredential({ name: "" })).res.status).toBe(400);
    expect((await createCredential({ kind: "bogus" })).res.status).toBe(400);
    // host 必填：凭证只对它声明的主机生效，缺 host 等于允许打任意主机
    expect((await createCredential({ host: "" })).res.status).toBe(400);
    expect((await createCredential({ secret: "" })).res.status).toBe(400);
  });

  it("host 落库前归一化", async () => {
    const { body } = await createCredential({ host: "Git.Example.COM." });
    expect(body.data.host).toBe("git.example.com");
  });

  it("同 team 重名 → 409", async () => {
    await createCredential();
    expect((await createCredential()).res.status).toBe(409);
  });

  it("非法 SSH 私钥 → 422（且不会入库）", async () => {
    const { res } = await createCredential({ kind: "ssh_key", name: "bad-key", secret: "not-a-key" });
    expect(res.status).toBe(422);
    const list = await json(await post("/source-credential/list", { team_id: TEAM }));
    expect(list.data.total).toBe(0);
  });

  it("KNOWLEDGE_SECRET_KEY 未配置 → 503", async () => {
    app = buildApp({ configured: false });
    const { res } = await createCredential();
    expect(res.status).toBe(503);
  });
});

describe("POST /list · /get", () => {
  it("list 只回本 team 的凭证", async () => {
    await createCredential();
    await createCredential({ name: "other", team_id: "team-2" });

    const body = await json(await post("/source-credential/list", { team_id: TEAM }));
    expect(body.data.total).toBe(1);
    expect(body.data.items[0].name).toBe("gitlab-pat");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("get 正常返回；跨 team / 不存在 → 404", async () => {
    const { body } = await createCredential();
    const id = body.data.credential_id;

    expect((await post("/source-credential/get", { team_id: TEAM, credential_id: id })).status).toBe(200);
    expect((await post("/source-credential/get", { team_id: "team-2", credential_id: id })).status).toBe(404);
    expect((await post("/source-credential/get", { team_id: TEAM, credential_id: "gc-00000000" })).status).toBe(404);
    expect((await post("/source-credential/get", { team_id: TEAM })).status).toBe(400);
  });
});

describe("POST /delete", () => {
  it("批量删除返回 deleted_ids / failed", async () => {
    const { body } = await createCredential();
    const id = body.data.credential_id;

    const res = await json(
      await post("/source-credential/delete", { team_id: TEAM, credential_ids: [id, "gc-00000000"] }),
    );
    expect(res.data.deleted_ids).toEqual([id]);
    expect(res.data.failed).toEqual([{ id: "gc-00000000", reason: "not found" }]);
  });

  it("空数组 / 超限 → 400", async () => {
    expect((await post("/source-credential/delete", { team_id: TEAM, credential_ids: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, i) => `gc-${String(i).padStart(8, "0")}`);
    expect((await post("/source-credential/delete", { team_id: TEAM, credential_ids: tooMany })).status).toBe(400);
  });

  it("跨 team 删除不到", async () => {
    const { body } = await createCredential();
    const res = await json(
      await post("/source-credential/delete", { team_id: "team-2", credential_ids: [body.data.credential_id] }),
    );
    expect(res.data.deleted_ids).toEqual([]);
  });
});

describe("POST /test —— host 强绑定", () => {
  it("host 不匹配 → 404，且**不**发起探测（防止 token 被发到任意主机）", async () => {
    const { body } = await createCredential();
    const res = await post("/source-credential/test", {
      team_id: TEAM,
      credential_id: body.data.credential_id,
      repo_url: "https://evil.example.com/o/r.git",
    });
    expect(res.status).toBe(404);
    expect(deps.probeRemote).not.toHaveBeenCalled();
  });

  it("凭证跨 team → 404", async () => {
    const { body } = await createCredential();
    const res = await post("/source-credential/test", {
      team_id: "team-2",
      credential_id: body.data.credential_id,
      repo_url: "https://git.example.com/o/r.git",
    });
    expect(res.status).toBe(404);
    expect(deps.probeRemote).not.toHaveBeenCalled();
  });

  it("host 匹配时先过 source-fetcher 校验，再探测", async () => {
    const { body } = await createCredential();
    const res = await post("/source-credential/test", {
      team_id: TEAM,
      credential_id: body.data.credential_id,
      repo_url: "https://git.example.com/o/r.git",
      branch: "main",
    });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ ok: true });
    expect(deps.validateRepoUrl).toHaveBeenCalledWith("https://git.example.com/o/r.git");
    expect(deps.probeRemote).toHaveBeenCalledTimes(1);
  });

  it("source-fetcher 校验失败 → 400，且不探测", async () => {
    app = buildApp({
      validateRepoUrl: () => {
        throw new Error("repo_url must not point to private/loopback address: git.example.com");
      },
    });
    const { body } = await createCredential();
    const res = await post("/source-credential/test", {
      team_id: TEAM,
      credential_id: body.data.credential_id,
      repo_url: "https://git.example.com/o/r.git",
    });
    expect(res.status).toBe(400);
    expect(deps.probeRemote).not.toHaveBeenCalled();
  });

  it("探测失败时把脱敏后的错误回传（不泄漏凭证）", async () => {
    app = buildApp({
      probeRemote: async () => ({
        ok: false,
        error: "Authentication failed for 'https://***@git.example.com/o/r.git' using ***",
      }),
    });
    const { body } = await createCredential();
    const res = await json(
      await post("/source-credential/test", {
        team_id: TEAM,
        credential_id: body.data.credential_id,
        repo_url: "https://git.example.com/o/r.git",
      }),
    );
    expect(res.data.ok).toBe(false);
    expect(res.data.error).not.toContain(TOKEN);
  });

  it("非法 repo_url → 400", async () => {
    const { body } = await createCredential();
    const res = await post("/source-credential/test", {
      team_id: TEAM,
      credential_id: body.data.credential_id,
      repo_url: "not a url",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /status · /providers", () => {
  it("status 只回子系统状态与数量，不回凭证内容", async () => {
    await createCredential();
    const res = await app.request("/source-credential/status", { headers: { "x-tdai-service-id": SERVICE } });
    const body = await json(res);
    expect(body.data).toEqual({ configured: true, count: 1, kinds: ["https_token", "ssh_key"] });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("status 缺 service_id → 400", async () => {
    const res = await app.request("/source-credential/status");
    expect(res.status).toBe(400);
  });

  it("未配置主密钥时 status 的 count 回落为 0", async () => {
    app = buildApp({ configured: false });
    const res = await app.request("/source-credential/status", { headers: { "x-tdai-service-id": SERVICE } });
    expect((await json(res)).data.count).toBe(0);
  });

  it("providers 返回支持的凭证类型（静态信息）", async () => {
    const body = await json(await app.request("/source-credential/providers"));
    expect(body.data.providers.map((p: { kind: string }) => p.kind)).toEqual(["https_token", "ssh_key"]);
  });
});
