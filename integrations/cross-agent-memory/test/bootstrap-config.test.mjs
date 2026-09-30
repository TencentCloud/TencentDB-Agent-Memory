import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OFFICIAL_IDENTITY_NAMES,
  bootstrapConfig
} from "../src/bootstrap-config.mjs";

const BOOTSTRAP_CLI = fileURLToPath(new URL("../src/bootstrap-config.mjs", import.meta.url));

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function withSandbox(run) {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-bootstrap-"));
  try {
    await run({
      adapterRoot: join(root, "integrations", "cross-agent-memory"),
      deployDir: join(root, "deploy", "global-images")
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCli({ adapterRoot, deployDir }) {
  const child = spawn(process.execPath, [BOOTSTRAP_CLI], {
    env: {
      ...process.env,
      CROSS_AGENT_MEMORY_TEST_MODE: "1",
      CROSS_AGENT_MEMORY_TEST_ADAPTER_ROOT: adapterRoot,
      CROSS_AGENT_MEMORY_TEST_DEPLOY_DIR: deployDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

async function withMetadataGateway(run) {
  const envelope = (data) => JSON.stringify({ code: 0, message: "ok", request_id: "request-1", data });
  const page = (items = []) => ({ items, total: items.length, limit: 100, offset: 0 });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const routes = {
      "/v3/meta/auth/verify": { valid: true, user: { user_id: "usr-owner", user_type: "system_admin", username: "admin", created_at: "2026-08-10T00:00:00.000Z" } },
      "/v3/meta/team/list": page(),
      "/v3/meta/team/create": { team_id: "team-1", name: "个人跨 Agent 记忆", owner_user_id: "usr-owner", status: "active" },
      "/v3/meta/agent/list": page(),
      "/v3/meta/agent/create": { agent_id: "agt-1", name: "共享个人助手", team_id: "team-1", owner_user_id: "usr-owner", visibility: "team", status: "active" },
      "/v3/meta/task/list": page(),
      "/v3/meta/task/create": { task_id: "task-1", title: "日常共享对话", team_id: "team-1", creator_user_id: "usr-owner", status: "running" },
      "/v3/meta/task-agent/list": page([{ task_id: "task-1", agent_id: "agt-1", status: "active" }]),
      "/v3/core/read": {}
    };
    if (!Object.hasOwn(routes, request.url)) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.end(envelope(routes[request.url]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(server.address().port);
  } finally {
    server.close();
    await once(server, "close");
  }
}

class MetadataFixture {
  constructor({ user = { user_id: "usr-owner", status: "active" } } = {}) {
    this.user = user;
    this.teams = [];
    this.agents = [];
    this.tasks = [];
    this.links = [];
    this.assets = [];
    this.agentCreateInputs = [];
    this.next = 1;
  }

  async verifyCurrentUser() { return this.user; }
  async listTeams({ name }) { return this.teams.filter((item) => item.name === name); }
  async createTeam({ name, ownerUserId }) {
    const team = { team_id: `team-${this.next++}`, name, owner_user_id: ownerUserId, status: "active" };
    this.teams.push(team);
    return team;
  }
  async listAgents({ teamId, name }) {
    return this.agents.filter((item) => item.team_id === teamId && item.name === name);
  }
  async createAgent({ teamId, ownerUserId, name, visibility }) {
    this.agentCreateInputs.push({ teamId, ownerUserId, name, visibility });
    const agent = { agent_id: `agt-${this.next++}`, team_id: teamId, owner_user_id: ownerUserId, name, visibility, status: "active" };
    this.agents.push(agent);
    return agent;
  }
  async listTasks({ teamId, title }) {
    return this.tasks.filter((item) => item.team_id === teamId && item.title === title);
  }
  async createTask({ teamId, creatorUserId, title, agentId }) {
    const task = { task_id: `task-${this.next++}`, team_id: teamId, creator_user_id: creatorUserId, title, status: "running" };
    this.tasks.push(task);
    this.links.push({ task_id: task.task_id, agent_id: agentId, status: "active" });
    return task;
  }
  async listTaskAgents({ taskId }) { return this.links.filter((item) => item.task_id === taskId); }
}

async function setupDeployment(deployDir) {
  await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY=gateway-test-token\nPANEL_PORT=18125\n");
  await writeText(join(deployDir, ".admin-key"), "admin-user-key-only-for-metadata\n");
}

function gatewayFactory(config) {
  return { readCore: async () => ({ acceptedIdentity: config.identity }) };
}

test("bootstrap creates the official metadata graph and writes only generated IDs", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    const metadata = new MetadataFixture();

    const result = await bootstrapConfig({ adapterRoot, deployDir, metadataClient: metadata, gatewayFactory });
    const config = JSON.parse(await readFile(join(adapterRoot, "config.local.json"), "utf8"));

    assert.equal(result.status, "CREATED");
    assert.deepEqual(config.identity, {
      userId: "usr-owner",
      teamId: "team-1",
      agentId: "agt-2",
      taskId: "task-3"
    });
    assert.equal(config.apiKey, "gateway-test-token");
    assert.equal(config.hubEndpoint, "http://127.0.0.1:18125");
    assert.equal(JSON.stringify(config).includes("admin-user-key-only-for-metadata"), false);
    assert.equal(metadata.teams[0].name, "个人跨 Agent 记忆");
    assert.equal(metadata.agents[0].name, "共享个人助手");
    assert.equal(metadata.agents[0].visibility, "team");
    assert.equal(metadata.agentCreateInputs[0].visibility, "team");
    assert.equal(metadata.tasks[0].title, "日常共享对话");
    assert.deepEqual(metadata.links, [{ task_id: "task-3", agent_id: "agt-2", status: "active" }]);
  });
});

test("bootstrap accepts the real public user projection without a status field", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    const metadata = new MetadataFixture({
      user: { user_id: "usr-owner", user_type: "system_admin", username: "admin", created_at: "2026-08-10T00:00:00.000Z" }
    });
    const result = await bootstrapConfig({ adapterRoot, deployDir, metadataClient: metadata, gatewayFactory });
    assert.equal(result.identity.userId, "usr-owner");
  });
});

test("bootstrap rejects generated metadata IDs that do not use the official prefixes", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    const metadata = new MetadataFixture();
    metadata.createTeam = async ({ name, ownerUserId }) => ({ team_id: "wrong-1", name, owner_user_id: ownerUserId, status: "active" });
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, metadataClient: metadata, gatewayFactory }),
      /metadata/i
    );
    await assert.rejects(readFile(join(adapterRoot, "config.local.json"), "utf8"), { code: "ENOENT" });
  });
});

test("bootstrap reuses one exact graph and completes a retry after partial creation", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    const metadata = new MetadataFixture();
    const team = await metadata.createTeam({ name: OFFICIAL_IDENTITY_NAMES.team, ownerUserId: "usr-owner" });
    const agent = await metadata.createAgent({ teamId: team.team_id, ownerUserId: "usr-owner", name: OFFICIAL_IDENTITY_NAMES.agent, visibility: "team" });
    let firstTaskCreate = true;
    const createTask = metadata.createTask.bind(metadata);
    metadata.createTask = async (input) => {
      if (firstTaskCreate) {
        firstTaskCreate = false;
        throw new Error("interrupted before task creation");
      }
      return createTask(input);
    };

    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, metadataClient: metadata, gatewayFactory }),
      /metadata/i
    );
    await assert.rejects(readFile(join(adapterRoot, "config.local.json"), "utf8"), { code: "ENOENT" });

    const result = await bootstrapConfig({ adapterRoot, deployDir, metadataClient: metadata, gatewayFactory });
    assert.equal(result.status, "CREATED");
    assert.equal(metadata.teams.length, 1);
    assert.equal(metadata.agents.length, 1);
    assert.equal(metadata.tasks.length, 1);
    assert.deepEqual(result.identity, { userId: "usr-owner", teamId: team.team_id, agentId: agent.agent_id, taskId: "task-3" });
  });
});

test("bootstrap refuses a private same-name agent and a renamed filtered entity without creating duplicates", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    const metadata = new MetadataFixture();
    const team = await metadata.createTeam({ name: OFFICIAL_IDENTITY_NAMES.team, ownerUserId: "usr-owner" });
    metadata.agents.push({
      agent_id: "agt-private",
      team_id: team.team_id,
      owner_user_id: "usr-owner",
      name: OFFICIAL_IDENTITY_NAMES.agent,
      visibility: "private",
      status: "active"
    });
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, metadataClient: metadata, gatewayFactory }),
      /relationship|metadata/i
    );
    assert.equal(metadata.agents.length, 1);
  });

  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    const metadata = new MetadataFixture();
    metadata.listTeams = async () => [{
      team_id: "team-renamed",
      name: "已改名团队",
      owner_user_id: "usr-owner",
      status: "active"
    }];
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, metadataClient: metadata, gatewayFactory }),
      /metadata/i
    );
    assert.equal(metadata.teams.length, 0);
  });
});

test("bootstrap stops on exact-name conflicts, malformed metadata, or invalid relationships without replacing config", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    const original = Buffer.from('{"keep":"original"}\r\n', "utf8");
    await mkdir(adapterRoot, { recursive: true });
    await writeFile(join(adapterRoot, "config.local.json"), original);
    const conflict = new MetadataFixture();
    await conflict.createTeam({ name: OFFICIAL_IDENTITY_NAMES.team, ownerUserId: "usr-owner" });
    await conflict.createTeam({ name: OFFICIAL_IDENTITY_NAMES.team, ownerUserId: "usr-owner" });

    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, force: true, metadataClient: conflict, gatewayFactory }),
      /conflict|metadata/i
    );
    assert.deepEqual(await readFile(join(adapterRoot, "config.local.json")), original);

    const malformed = new MetadataFixture();
    malformed.verifyCurrentUser = async () => ({ user_id: "not-official" });
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, force: true, metadataClient: malformed, gatewayFactory }),
      /metadata/i
    );
    assert.deepEqual(await readFile(join(adapterRoot, "config.local.json")), original);

    const denied = new MetadataFixture();
    denied.listTeams = async () => { throw new Error("permission denied"); };
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, force: true, metadataClient: denied, gatewayFactory }),
      /metadata/i
    );
    assert.deepEqual(await readFile(join(adapterRoot, "config.local.json")), original);

    const mismatch = new MetadataFixture();
    const wrongTeam = await mismatch.createTeam({ name: OFFICIAL_IDENTITY_NAMES.team, ownerUserId: "usr-other" });
    await mismatch.createAgent({ teamId: wrongTeam.team_id, ownerUserId: "usr-owner", name: OFFICIAL_IDENTITY_NAMES.agent, visibility: "team" });
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, force: true, metadataClient: mismatch, gatewayFactory }),
      /relationship|metadata/i
    );
    assert.deepEqual(await readFile(join(adapterRoot, "config.local.json")), original);
  });
});

test("bootstrap requires an admin key and preserves original bytes if replacement fails", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY=gateway-test-token\n");
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, metadataClient: new MetadataFixture(), gatewayFactory }),
      /admin.*key/i
    );

    await setupDeployment(deployDir);
    const original = Buffer.from('{"legacy":true}\r\n', "utf8");
    await mkdir(adapterRoot, { recursive: true });
    await writeFile(join(adapterRoot, "config.local.json"), original);
    const result = bootstrapConfig({
      adapterRoot,
      deployDir,
      force: true,
      metadataClient: new MetadataFixture(),
      gatewayFactory,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      renameFile: async () => { throw new Error("replace failure"); }
    });
    await assert.rejects(result, /replace/i);
    assert.deepEqual(await readFile(join(adapterRoot, "config.local.json")), original);
    const backupPath = join(adapterRoot, "runtime", "backups", `bootstrap-2026-08-10T00-00-00.000Z-${process.pid}`, "config.local.json");
    assert.deepEqual(await readFile(backupPath), original);
  });
});

test("bootstrap preserves legacy no-force, disabled-Bearer, raw-backup, env, and Gateway safeguards", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    const original = `${JSON.stringify({ endpoint: "http://127.0.0.1:8420", apiKey: "old", serviceId: "default", identity: { userId: "usr-owner", teamId: "team-1", agentId: "agt-1", taskId: "task-1" } })}\n`;
    await writeText(join(adapterRoot, "config.local.json"), original);
    await assert.rejects(bootstrapConfig({ adapterRoot, deployDir }), /already exists.*--force/i);
    assert.equal(await readFile(join(adapterRoot, "config.local.json"), "utf8"), original);
  });

  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY= # disabled\n");
    await writeText(join(deployDir, ".admin-key"), "admin-secret");
    const result = await bootstrapConfig({ adapterRoot, deployDir, metadataClient: new MetadataFixture(), gatewayFactory });
    const config = JSON.parse(await readFile(join(adapterRoot, "config.local.json"), "utf8"));
    assert.equal(result.credentialMode, "bearer-disabled-local-fallback");
    assert.equal(config.apiKey.includes("admin-secret"), false);
  });

  await withSandbox(async ({ adapterRoot, deployDir }) => {
    const original = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0d, 0x0a]);
    await mkdir(adapterRoot, { recursive: true });
    await writeFile(join(adapterRoot, "config.local.json"), original);
    await setupDeployment(deployDir);
    const result = await bootstrapConfig({ adapterRoot, deployDir, force: true, metadataClient: new MetadataFixture(), gatewayFactory });
    assert.deepEqual(await readFile(result.backupPath), original);

    await assert.rejects(bootstrapConfig({ adapterRoot: join(adapterRoot, "missing"), deployDir: join(deployDir, "missing") }), /deployment.*\.env/i);
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY=unterminated value here\n");
    await assert.rejects(bootstrapConfig({ adapterRoot: join(adapterRoot, "bad"), deployDir }), /gateway.*invalid/i);
  });

  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, metadataClient: new MetadataFixture(), gatewayFactory: () => ({ readCore: async () => { throw new Error("secret"); } }) }),
      /official identity.*gateway/i
    );
    await assert.rejects(readFile(join(adapterRoot, "config.local.json"), "utf8"), { code: "ENOENT" });
  });
});

test("bootstrap CLI stays sanitized while using metadata and Gateway credentials separately", async () => {
  await withMetadataGateway(async (port) => {
    await withSandbox(async ({ adapterRoot, deployDir }) => {
      const gatewaySecret = "gateway-cli-secret";
      const adminSecret = "admin-cli-secret";
      await writeText(join(deployDir, ".env"), `MEMORY_CORE_PORT=${port}\nMEMORY_CORE_GATEWAY_API_KEY=${gatewaySecret}\n`);
      await writeText(join(deployDir, ".admin-key"), adminSecret);
      const result = await runCli({ adapterRoot, deployDir });
      assert.equal(result.code, 0);
      assert.equal(`${result.stdout}${result.stderr}`.includes(gatewaySecret), false);
      assert.equal(`${result.stdout}${result.stderr}`.includes(adminSecret), false);
    });
  });
});

test("bootstrap separately refuses a valid existing config without --force", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    const original = `${JSON.stringify({ endpoint: "http://127.0.0.1:8420", apiKey: "old", serviceId: "default", identity: { userId: "usr-owner", teamId: "team-1", agentId: "agt-1", taskId: "task-1" } })}\n`;
    await writeText(join(adapterRoot, "config.local.json"), original);
    await assert.rejects(bootstrapConfig({ adapterRoot, deployDir }), /already exists.*--force/i);
    assert.equal(await readFile(join(adapterRoot, "config.local.json"), "utf8"), original);
  });
});

test("bootstrap separately preserves exact bytes for a forced replacement backup", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    const original = Buffer.from([0x7b, 0xff, 0x7d, 0x0d, 0x0a]);
    await mkdir(adapterRoot, { recursive: true });
    await writeFile(join(adapterRoot, "config.local.json"), original);
    await setupDeployment(deployDir);
    const result = await bootstrapConfig({ adapterRoot, deployDir, force: true, metadataClient: new MetadataFixture(), gatewayFactory });
    assert.deepEqual(await readFile(result.backupPath), original);
  });
});

test("bootstrap test sandbox keeps both primary and cleanup failures", async () => {
  const primary = new Error("primary");
  const cleanup = new Error("cleanup");
  async function sandboxWithCleanup(run, remove) {
    const root = await mkdtemp(join(tmpdir(), "cross-agent-bootstrap-cleanup-"));
    let bodyError;
    try { await run(root); } catch (error) { bodyError = error; }
    let cleanupError;
    try { await remove(root); } catch (error) { cleanupError = error; }
    if (bodyError && cleanupError) throw new AggregateError([bodyError, cleanupError]);
    if (bodyError) throw bodyError;
    if (cleanupError) throw cleanupError;
  }
  await assert.rejects(sandboxWithCleanup(async () => { throw primary; }, async () => { throw cleanup; }),
    (error) => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup);
});

test("disabled Bearer gate never substitutes the administrator key", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY= # disabled\n");
    await writeText(join(deployDir, ".admin-key"), "administrator-only-secret");
    const result = await bootstrapConfig({ adapterRoot, deployDir, metadataClient: new MetadataFixture(), gatewayFactory });
    const config = JSON.parse(await readFile(join(adapterRoot, "config.local.json"), "utf8"));
    assert.equal(result.credentialMode, "bearer-disabled-local-fallback");
    assert.equal(config.apiKey.includes("administrator-only-secret"), false);
  });
});

test("missing or malformed deployment Gateway configuration leaves no config", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await assert.rejects(bootstrapConfig({ adapterRoot, deployDir }), /deployment.*\.env/i);
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_PORT=bad\nMEMORY_CORE_GATEWAY_API_KEY=\n");
    await assert.rejects(bootstrapConfig({ adapterRoot, deployDir }), /port/i);
    await assert.rejects(readFile(join(adapterRoot, "config.local.json"), "utf8"), { code: "ENOENT" });
  });
});

test("bootstrap rejects an invalid deployment Panel port instead of writing an unusable Hub endpoint", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY=gateway-test-token\nPANEL_PORT=not-a-port\n");
    await writeText(join(deployDir, ".admin-key"), "admin-test-key\n");
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, metadataClient: new MetadataFixture(), gatewayFactory }),
      /Panel|PANEL_PORT|port/i
    );
    await assert.rejects(readFile(join(adapterRoot, "config.local.json"), "utf8"), { code: "ENOENT" });
  });
});

test("Gateway rejection does not write a verified metadata identity", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, metadataClient: new MetadataFixture(), gatewayFactory: () => ({ readCore: async () => { throw new Error("rejected"); } }) }),
      /official identity.*gateway/i
    );
    await assert.rejects(readFile(join(adapterRoot, "config.local.json"), "utf8"), { code: "ENOENT" });
  });
});

test("bootstrap CLI preserves exact existing-config, missing-env, and invalid-port failures", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(adapterRoot, "config.local.json"), `${JSON.stringify({ endpoint: "http://127.0.0.1:8420", apiKey: "existing-cli-secret", serviceId: "default", identity: { userId: "usr-owner", teamId: "team-1", agentId: "agt-1", taskId: "task-1" } })}\n`);
    assert.deepEqual(await runCli({ adapterRoot, deployDir }), {
      code: 1, stdout: "", stderr: "[FAIL] 配置未写入：config.local.json 已存在；如需替换请使用 --force。\n"
    });
  });
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    assert.deepEqual(await runCli({ adapterRoot, deployDir }), {
      code: 1, stdout: "", stderr: "[FAIL] 配置未写入：缺少本地部署配置 deploy/global-images/.env。\n"
    });
  });
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_PORT=not-a-port\nMEMORY_CORE_GATEWAY_API_KEY=\n");
    assert.deepEqual(await runCli({ adapterRoot, deployDir }), {
      code: 1, stdout: "", stderr: "[FAIL] 配置未写入：本地 Gateway 端口配置无效。\n"
    });
  });
});

test("bootstrap CLI reports an exact sanitized Gateway rejection after real metadata calls", async () => {
  const envelope = (data) => JSON.stringify({ code: 0, message: "ok", request_id: "request-1", data });
  const page = (items = []) => ({ items, total: items.length, limit: 100, offset: 0 });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v3/core/read") {
      response.statusCode = 403;
      response.end("sensitive Gateway rejection body");
      return;
    }
    const routes = {
      "/v3/meta/auth/verify": { valid: true, user: { user_id: "usr-owner", user_type: "system_admin", username: "admin", created_at: "2026-08-10T00:00:00.000Z" } },
      "/v3/meta/team/list": page(),
      "/v3/meta/team/create": { team_id: "team-1", name: "个人跨 Agent 记忆", owner_user_id: "usr-owner", status: "active" },
      "/v3/meta/agent/list": page(),
      "/v3/meta/agent/create": { agent_id: "agt-1", name: "共享个人助手", team_id: "team-1", owner_user_id: "usr-owner", visibility: "team", status: "active" },
      "/v3/meta/task/list": page(),
      "/v3/meta/task/create": { task_id: "task-1", title: "日常共享对话", team_id: "team-1", creator_user_id: "usr-owner", status: "running" },
      "/v3/meta/task-agent/list": page([{ task_id: "task-1", agent_id: "agt-1", status: "active" }])
    };
    response.end(envelope(routes[request.url]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await withSandbox(async ({ adapterRoot, deployDir }) => {
      const gatewaySecret = "gateway-reject-cli-secret";
      const adminSecret = "admin-reject-cli-secret";
      await writeText(join(deployDir, ".env"), `MEMORY_CORE_PORT=${server.address().port}\nMEMORY_CORE_GATEWAY_API_KEY=${gatewaySecret}\n`);
      await writeText(join(deployDir, ".admin-key"), adminSecret);
      const result = await runCli({ adapterRoot, deployDir });
      assert.deepEqual(result, {
        code: 1, stdout: "", stderr: "[FAIL] 配置未写入：MemoryCore/Gateway 不可用或拒绝正式身份。\n"
      });
      assert.equal(`${result.stdout}${result.stderr}`.includes(gatewaySecret), false);
      assert.equal(`${result.stdout}${result.stderr}`.includes(adminSecret), false);
      assert.equal(`${result.stdout}${result.stderr}`.includes("sensitive Gateway rejection body"), false);
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});
