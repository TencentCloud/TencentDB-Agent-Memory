import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { formatDoctorReport, isClientHookConfigRegistered, runDoctor } from "../src/doctor.mjs";

const ADAPTER_PATH = resolve("integrations/cross-agent-memory/src/hook-cli.mjs");

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function registerAllHooks(userProfile) {
  const group = (entry) => ({ hooks: [entry] });
  await writeJson(join(userProfile, ".codex", "hooks.json"), { hooks: {
    UserPromptSubmit: [group({ type: "command", command: `node ${ADAPTER_PATH.replaceAll("\\", "/")} codex`, commandWindows: `node \"${ADAPTER_PATH}\" codex`, timeout: 5 })],
    Stop: [group({ type: "command", command: `node ${ADAPTER_PATH.replaceAll("\\", "/")} codex`, commandWindows: `node \"${ADAPTER_PATH}\" codex`, timeout: 5 })]
  } });
  await writeJson(join(userProfile, ".claude", "settings.json"), { hooks: {
    UserPromptSubmit: [group({ type: "command", command: `node \"${ADAPTER_PATH}\" claude`, timeout: 5 })],
    Stop: [group({ type: "command", command: `node \"${ADAPTER_PATH}\" claude`, timeout: 5 })]
  } });
  await writeJson(join(userProfile, ".zcode", "cli", "config.json"), { hooks: {
    enabled: true,
    events: {
      UserPromptSubmit: [group({ type: "process", command: "node", args: [ADAPTER_PATH, "zcode"], enabled: true, timeoutMs: 5000 })],
      Stop: [group({ type: "process", command: "node", args: [ADAPTER_PATH, "zcode"], enabled: true, timeoutMs: 5000 })]
    }
  } });
}

async function withSandbox(run) {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-doctor-"));
  try {
    const adapterRoot = join(root, "adapter");
    await writeJson(join(adapterRoot, "config.local.json"), {
      endpoint: "http://127.0.0.1:8420",
      apiKey: "gateway-doctor-token",
      serviceId: "default",
      identity: { userId: "usr-owner", teamId: "team-1", agentId: "agt-1", taskId: "task-1" }
    });
    await run(adapterRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function healthyGateway() {
  return {
    searchConversation: async () => [], searchAtomic: async () => [], readCore: async () => ({})
  };
}

function healthyMetadata() {
  return {
    getUser: async () => ({ user_id: "usr-owner", user_type: "system_admin", username: "admin", created_at: "2026-08-10T00:00:00.000Z" }),
    getTeam: async () => ({ team_id: "team-1", name: "个人跨 Agent 记忆", owner_user_id: "usr-owner", status: "active" }),
    getAgent: async () => ({ agent_id: "agt-1", name: "共享个人助手", team_id: "team-1", owner_user_id: "usr-owner", visibility: "team", status: "active" }),
    getTask: async () => ({ task_id: "task-1", title: "日常共享对话", team_id: "team-1", creator_user_id: "usr-owner", status: "running" }),
    listTaskAgents: async () => [{ task_id: "task-1", agent_id: "agt-1", status: "active" }]
  };
}

function officialBlock(overrides = {}) {
  return {
    id: "chat_memory-team-1-agt-1",
    title: "共享个人助手",
    summary: "0 条 L1 · 0 条 L2 · 0 条 L3",
    uploaded_by_user_id: "usr-owner",
    updated_at_ms: 0,
    layer_counts: { L0_messages: 0, L1: 0, L2: 0, L3: 0 },
    scope: "private",
    agent_id: "agt-1",
    ...overrides
  };
}

function healthyHub({ total = 1, blocks = [officialBlock()] } = {}) {
  return {
    listMyAgents: async () => ({ items: blocks, total: blocks.length }),
    readLayer: async () => ({
      layer: "L0",
      items: total > 0 ? [{ id: "msg-1", role: "user", title: "user @ session", body: "stored", tags: ["user"], refs: [] }] : [],
      total,
      limit: 1,
      offset: 0
    })
  };
}

test("doctor validates the real public user projection, exact official graph, Hub block, and positive L0 total", async () => {
  await withSandbox(async (rootDir) => {
    const checks = await runDoctor({
      rootDir,
      nodeVersion: "25.2.1",
      healthCheck: async () => true,
      gatewayFactory: healthyGateway,
      metadataClient: healthyMetadata(),
      hubClient: healthyHub(),
      hookChecker: async () => true
    });
    assert.deepEqual(checks.filter((check) => check.name.startsWith("identity") || check.name === "chat-memory").map(({ name, status }) => [name, status]), [
      ["identity", "PASS"], ["chat-memory", "PASS"]
    ]);
    assert.equal(formatDoctorReport(checks).includes("gateway-doctor-token"), false);
  });
});

test("doctor reports an invalid identity graph and does not call the Hub", async () => {
  await withSandbox(async (rootDir) => {
    const metadata = healthyMetadata();
    metadata.getAgent = async () => ({ agent_id: "agt-1", team_id: "team-other", owner_user_id: "usr-owner", status: "active" });
    let hubCalls = 0;
    const checks = await runDoctor({
      rootDir,
      nodeVersion: "25.2.1",
      healthCheck: async () => true,
      gatewayFactory: healthyGateway,
      metadataClient: metadata,
      hubClient: { listMyAgents: async () => { hubCalls += 1; throw new Error("must not run"); } },
      hookChecker: async () => true
    });
    const result = Object.fromEntries(checks.map(({ name, status }) => [name, status]));
    assert.equal(result.identity, "FAIL");
    assert.equal(result["chat-memory"], "FAIL");
    assert.equal(hubCalls, 0);
  });
});

test("doctor reports WAIT only when a valid official identity has not produced chat_memory yet", async () => {
  await withSandbox(async (rootDir) => {
    const checks = await runDoctor({ rootDir, nodeVersion: "25.2.1", healthCheck: async () => true, gatewayFactory: healthyGateway, metadataClient: healthyMetadata(), hubClient: healthyHub({ total: 0 }), hookChecker: async () => true });
    assert.equal(checks.find((check) => check.name === "identity").status, "PASS");
    assert.equal(checks.find((check) => check.name === "chat-memory").status, "WAIT");
  });
});

test("doctor still accepts only complete hook registrations", () => {
  const adapterPath = "C:/memory/hook-cli.mjs";
  const command = `node ${adapterPath} codex`;
  const codex = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command, commandWindows: `node \"${adapterPath}\" codex`, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: "command", command, commandWindows: `node \"${adapterPath}\" codex`, timeout: 5 }] }]
    }
  };
  assert.equal(isClientHookConfigRegistered(codex, "codex", adapterPath), true);
  codex.hooks.Stop[0].hooks[0].timeout = 0;
  assert.equal(isClientHookConfigRegistered(codex, "codex", adapterPath), false);
});

test("doctor retains full legacy PASS, FAIL, optional-write, missing-config, and hook-negative coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-doctor-legacy-"));
  try {
    const adapterRoot = join(root, "adapter");
    const userProfile = join(root, "profile");
    await writeJson(join(adapterRoot, "config.local.json"), {
      endpoint: "http://127.0.0.1:8420", apiKey: "doctor-secret", serviceId: "default",
      identity: { userId: "usr-owner", teamId: "team-1", agentId: "agt-1", taskId: "task-1" }
    });
    await registerAllHooks(userProfile);
    let writes = 0;
    const options = {
      rootDir: adapterRoot, userProfile, adapterPath: ADAPTER_PATH, nodeVersion: "25.2.1",
      healthCheck: async () => true,
      gatewayFactory: () => ({ ...healthyGateway(), addConversation: async () => { writes += 1; } }),
      metadataClient: healthyMetadata(),
      hubClient: healthyHub()
    };
    const checks = await runDoctor(options);
    for (const name of ["config", "node", "gateway", "l0", "l1", "l3", "write", "identity", "chat-memory", "hook-codex", "hook-claude", "hook-zcode"]) {
      assert.equal(checks.find((check) => check.name === name).status, "PASS", name);
    }
    assert.equal(writes, 0);
    assert.equal(formatDoctorReport(checks).includes("doctor-secret"), false);
    const withWrite = await runDoctor({ ...options, write: true });
    assert.equal(withWrite.find((check) => check.name === "write").status, "PASS");
    assert.equal(writes, 1);

    await writeJson(join(userProfile, ".codex", "hooks.json"), { hooks: { UserPromptSubmit: [], Stop: [] } });
    const failed = await runDoctor({
      ...options,
      nodeVersion: "22.15.0",
      healthCheck: async () => { throw new Error("sensitive failure"); },
      gatewayFactory: () => ({ ...healthyGateway(), searchConversation: async () => { throw new Error("sensitive failure"); } })
    });
    const statuses = Object.fromEntries(failed.map(({ name, status }) => [name, status]));
    assert.equal(statuses.node, "FAIL");
    assert.equal(statuses.gateway, "FAIL");
    assert.equal(statuses.l0, "FAIL");
    assert.equal(statuses["hook-codex"], "FAIL");
    assert.equal(formatDoctorReport(failed).includes("sensitive failure"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const missingRoot = await mkdtemp(join(tmpdir(), "cross-agent-doctor-missing-"));
  try {
    const missing = await runDoctor({ rootDir: join(missingRoot, "adapter"), userProfile: join(missingRoot, "profile"), nodeVersion: "25.2.1", healthCheck: async () => true });
    for (const name of ["config", "gateway", "l0", "l1", "l3", "write", "identity", "chat-memory"]) {
      assert.equal(missing.find((check) => check.name === name).status, "FAIL", name);
    }
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }
});

test("doctor rejects every incomplete handler shape for Codex, Claude, and ZCode", () => {
  const path = "C:/memory/hook-cli.mjs";
  const codex = { type: "command", command: `node ${path} codex`, commandWindows: `node \"${path}\" codex`, timeout: 5 };
  const claude = { type: "command", command: `node \"${path}\" claude`, timeout: 5 };
  const zcode = { type: "process", command: "node", args: [path, "zcode"], enabled: true, timeoutMs: 5000 };
  const configFor = (client, entry, enabled = true) => client === "zcode"
    ? { hooks: { enabled, events: { UserPromptSubmit: [{ hooks: [entry] }], Stop: [{ hooks: [entry] }] } } }
    : { hooks: { UserPromptSubmit: [{ hooks: [entry] }], Stop: [{ hooks: [entry] }] } };
  assert.equal(isClientHookConfigRegistered(configFor("codex", codex), "codex", path), true);
  assert.equal(isClientHookConfigRegistered(configFor("claude", claude), "claude", path), true);
  assert.equal(isClientHookConfigRegistered(configFor("zcode", zcode), "zcode", path), true);
  assert.equal(isClientHookConfigRegistered(configFor("codex", { ...codex, timeout: 0 }), "codex", path), false);
  assert.equal(isClientHookConfigRegistered(configFor("claude", { ...claude, command: `node \"${path}\" codex` }), "claude", path), false);
  assert.equal(isClientHookConfigRegistered(configFor("zcode", { ...zcode, args: [path, "claude"] }), "zcode", path), false);
  assert.equal(isClientHookConfigRegistered(configFor("zcode", zcode, false), "zcode", path), false);
});

test("doctor retains the full three-client handler negative matrix", () => {
  const path = "C:/memory/hook-cli.mjs";
  const codex = { type: "command", command: `node ${path} codex`, commandWindows: `node \"${path}\" codex`, timeout: 5 };
  const claude = { type: "command", command: `node \"${path}\" claude`, timeout: 5 };
  const zcode = { type: "process", command: "node", args: [path, "zcode"], enabled: true, timeoutMs: 5000 };
  const configFor = (client, entry, enabled = true) => client === "zcode"
    ? { hooks: { enabled, events: { UserPromptSubmit: [{ hooks: [entry] }], Stop: [{ hooks: [entry] }] } } }
    : { hooks: { UserPromptSubmit: [{ hooks: [entry] }], Stop: [{ hooks: [entry] }] } };
  for (const entry of [
    { ...codex, type: "process" }, { ...codex, command: `node ${path}.old codex` },
    { ...codex, commandWindows: `node \"${path}-backup\" codex` }, { ...codex, command: `node ${path} claude`, commandWindows: `node \"${path}\" claude` },
    { ...codex, command: `bun ${path} codex` }, { ...codex, timeout: 0 }
  ]) assert.equal(isClientHookConfigRegistered(configFor("codex", entry), "codex", path), false);
  for (const entry of [
    { ...claude, type: "process" }, { ...claude, command: `node \"${path}.old\" claude` },
    { ...claude, command: `node \"${path}\" codex` }, { ...claude, command: `bun \"${path}\" claude` }, { ...claude, timeout: 0 }
  ]) assert.equal(isClientHookConfigRegistered(configFor("claude", entry), "claude", path), false);
  for (const entry of [
    { ...zcode, type: "command" }, { ...zcode, command: "node.exe" }, { ...zcode, args: [`${path}.old`, "zcode"] },
    { ...zcode, args: [path, "claude"] }, { ...zcode, args: [path, "zcode", "extra"] }, { ...zcode, enabled: false }, { ...zcode, timeoutMs: 0 }
  ]) assert.equal(isClientHookConfigRegistered(configFor("zcode", entry), "zcode", path), false);
  assert.equal(isClientHookConfigRegistered(configFor("zcode", zcode, false), "zcode", path), false);
});

test("doctor marks missing configuration and both metadata checks as failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-doctor-missing-explicit-"));
  try {
    const checks = await runDoctor({ rootDir: join(root, "adapter"), userProfile: join(root, "profile"), nodeVersion: "25.2.1", healthCheck: async () => true });
    for (const name of ["config", "gateway", "l0", "l1", "l3", "write", "identity", "chat-memory"]) {
      assert.equal(checks.find((check) => check.name === name).status, "FAIL", name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor fails malformed official IDs and does not downgrade the asset check to WAIT", async () => {
  await withSandbox(async (rootDir) => {
    const metadata = healthyMetadata();
    metadata.getTeam = async () => ({ team_id: "bad-team", owner_user_id: "usr-owner", status: "active" });
    const checks = await runDoctor({ rootDir, nodeVersion: "25.2.1", healthCheck: async () => true, gatewayFactory: healthyGateway, metadataClient: metadata, hubClient: healthyHub(), hookChecker: async () => true });
    assert.equal(checks.find((check) => check.name === "identity").status, "FAIL");
    assert.equal(checks.find((check) => check.name === "chat-memory").status, "FAIL");
  });
});

test("doctor executes its write probe only with --write behavior", async () => {
  await withSandbox(async (rootDir) => {
    let writes = 0;
    const gatewayFactory = () => ({ ...healthyGateway(), addConversation: async () => { writes += 1; } });
    const options = { rootDir, nodeVersion: "25.2.1", healthCheck: async () => true, gatewayFactory, metadataClient: healthyMetadata(), hubClient: healthyHub(), hookChecker: async () => true };
    const withoutWrite = await runDoctor(options);
    assert.equal(withoutWrite.find((check) => check.name === "write").status, "PASS");
    assert.equal(writes, 0);
    const withWrite = await runDoctor({ ...options, write: true });
    assert.equal(withWrite.find((check) => check.name === "write").status, "PASS");
    assert.equal(writes, 1);
  });
});

test("doctor preserves both primary and cleanup errors in its sandbox helper", async () => {
  const primary = new Error("primary");
  const cleanup = new Error("cleanup");
  async function sandbox(run, remove) {
    const root = await mkdtemp(join(tmpdir(), "cross-agent-doctor-cleanup-"));
    let bodyError;
    try { await run(root); } catch (error) { bodyError = error; }
    let cleanupError;
    try { await remove(root); } catch (error) { cleanupError = error; }
    if (bodyError && cleanupError) throw new AggregateError([bodyError, cleanupError]);
    if (bodyError) throw bodyError;
    if (cleanupError) throw cleanupError;
  }
  await assert.rejects(sandbox(async () => { throw primary; }, async () => { throw cleanup; }),
    (error) => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup);
});

for (const [label, block] of [
  ["wrong block ID", officialBlock({ id: "chat_memory-team-1-agt-other" })],
  ["wrong agent ID", officialBlock({ agent_id: "agt-other" })],
  ["wrong owner", officialBlock({ uploaded_by_user_id: "usr-other" })],
  ["renamed title", officialBlock({ title: "已改名助手" })]
]) {
  test(`doctor does not PASS a Hub chat-memory block with ${label}`, async () => {
    await withSandbox(async (rootDir) => {
      const checks = await runDoctor({ rootDir, nodeVersion: "25.2.1", healthCheck: async () => true, gatewayFactory: healthyGateway, metadataClient: healthyMetadata(), hubClient: healthyHub({ blocks: [block] }), hookChecker: async () => true });
      assert.equal(checks.find((check) => check.name === "identity").status, "PASS");
      assert.equal(checks.find((check) => check.name === "chat-memory").status, "FAIL");
    });
  });
}

for (const [label, mutate] of [
  ["private same-name agent", (metadata) => { metadata.getAgent = async () => ({ agent_id: "agt-1", name: "共享个人助手", team_id: "team-1", owner_user_id: "usr-owner", visibility: "private", status: "active" }); }],
  ["renamed team", (metadata) => { metadata.getTeam = async () => ({ team_id: "team-1", name: "已改名团队", owner_user_id: "usr-owner", status: "active" }); }],
  ["renamed agent", (metadata) => { metadata.getAgent = async () => ({ agent_id: "agt-1", name: "已改名助手", team_id: "team-1", owner_user_id: "usr-owner", visibility: "team", status: "active" }); }],
  ["renamed task", (metadata) => { metadata.getTask = async () => ({ task_id: "task-1", title: "已改名任务", team_id: "team-1", creator_user_id: "usr-owner", status: "running" }); }],
  ["inactive task-agent link", (metadata) => { metadata.listTaskAgents = async () => [{ task_id: "task-1", agent_id: "agt-1", status: "inactive" }]; }]
]) {
  test(`doctor rejects a non-official identity graph with ${label}`, async () => {
    await withSandbox(async (rootDir) => {
      const metadata = healthyMetadata();
      mutate(metadata);
      const checks = await runDoctor({ rootDir, nodeVersion: "25.2.1", healthCheck: async () => true, gatewayFactory: healthyGateway, metadataClient: metadata, hubClient: healthyHub(), hookChecker: async () => true });
      assert.equal(checks.find((check) => check.name === "identity").status, "FAIL");
      assert.equal(checks.find((check) => check.name === "chat-memory").status, "FAIL");
    });
  });
}

test("doctor --write refuses to add a conversation until the official task-agent graph is valid", async () => {
  await withSandbox(async (rootDir) => {
    let writes = 0;
    let hubCalls = 0;
    const metadata = healthyMetadata();
    metadata.getTask = async () => ({ task_id: "task-1", title: "已改名任务", team_id: "team-1", creator_user_id: "usr-owner", status: "running" });
    const checks = await runDoctor({
      rootDir,
      nodeVersion: "25.2.1",
      write: true,
      healthCheck: async () => true,
      gatewayFactory: () => ({ ...healthyGateway(), addConversation: async () => { writes += 1; } }),
      metadataClient: metadata,
      hubClient: { listMyAgents: async () => { hubCalls += 1; return { items: [officialBlock()], total: 1 }; } },
      hookChecker: async () => true
    });
    assert.equal(checks.find((check) => check.name === "identity").status, "FAIL");
    assert.equal(checks.find((check) => check.name === "write").status, "FAIL");
    assert.equal(writes, 0);
    assert.equal(hubCalls, 0);
  });
});

test("doctor fails closed when Hub is unreachable or returns a malformed L0 page", async () => {
  await withSandbox(async (rootDir) => {
    const unavailable = await runDoctor({
      rootDir,
      nodeVersion: "25.2.1",
      healthCheck: async () => true,
      gatewayFactory: healthyGateway,
      metadataClient: healthyMetadata(),
      hubClient: { listMyAgents: async () => { throw new Error("sensitive upstream detail"); } },
      hookChecker: async () => true
    });
    assert.equal(unavailable.find((check) => check.name === "chat-memory").status, "FAIL");
    assert.equal(formatDoctorReport(unavailable).includes("sensitive upstream detail"), false);

    const malformed = await runDoctor({
      rootDir,
      nodeVersion: "25.2.1",
      healthCheck: async () => true,
      gatewayFactory: healthyGateway,
      metadataClient: healthyMetadata(),
      hubClient: {
        listMyAgents: async () => ({ items: [officialBlock()], total: 1 }),
        readLayer: async () => ({ layer: "L0", items: [], total: -1, limit: 1, offset: 0 })
      },
      hookChecker: async () => true
    });
    assert.equal(malformed.find((check) => check.name === "chat-memory").status, "FAIL");
  });
});

test("doctor uses the real Panel routes, headers, envelopes, and exact L0 total", async () => {
  const requests = [];
  const secret = "hub-admin-secret";
  const server = createServer(async (request, response) => {
    let source = "";
    request.setEncoding("utf8");
    for await (const chunk of request) source += chunk;
    requests.push({
      path: request.url,
      body: JSON.parse(source),
      serviceId: request.headers["x-tdai-service-id"],
      userKey: request.headers["x-tdai-user-key"],
      authorization: request.headers.authorization
    });
    const data = request.url?.endsWith("/my-agents")
      ? { items: [officialBlock()], total: 1 }
      : { layer: "L0", items: [{ id: "msg-1", role: "user", title: "user @ session", body: "stored", tags: ["user"], refs: [] }], total: 1, limit: 1, offset: 0 };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ code: 0, message: "ok", request_id: `hub-${requests.length}`, data }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await withSandbox(async (rootDir) => {
      const deployDir = join(dirname(rootDir), "deploy");
      await mkdir(deployDir, { recursive: true });
      await writeFile(join(deployDir, ".admin-key"), secret, "utf8");
      await writeJson(join(rootDir, "config.local.json"), {
        endpoint: "http://127.0.0.1:8420",
        hubEndpoint: `http://127.0.0.1:${server.address().port}`,
        apiKey: "gateway-doctor-token",
        serviceId: "default",
        identity: { userId: "usr-owner", teamId: "team-1", agentId: "agt-1", taskId: "task-1" },
        timeouts: { recallMs: 200, captureMs: 3000 }
      });
      const checks = await runDoctor({ rootDir, deployDir, nodeVersion: "25.2.1", healthCheck: async () => true, gatewayFactory: healthyGateway, metadataClient: healthyMetadata(), hookChecker: async () => true });
      assert.equal(checks.find((check) => check.name === "chat-memory").status, "PASS");
      assert.equal(formatDoctorReport(checks).includes(secret), false);
    });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
  assert.deepEqual(requests, [
    {
      path: "/api/v1/chat-memory/my-agents",
      body: { team_id: "team-1" },
      serviceId: "default",
      userKey: secret,
      authorization: undefined
    },
    {
      path: "/api/v1/chat-memory/layer",
      body: { block_id: "chat_memory-team-1-agt-1", layer: "L0", limit: 1, offset: 0 },
      serviceId: "default",
      userKey: secret,
      authorization: undefined
    }
  ]);
});

test("doctor aborts a hanging Hub fetch within the configured finite timeout", async () => {
  let requests = 0;
  const server = createServer(() => { requests += 1; });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await withSandbox(async (rootDir) => {
      const deployDir = join(dirname(rootDir), "deploy");
      await mkdir(deployDir, { recursive: true });
      await writeFile(join(deployDir, ".admin-key"), "hub-timeout-secret", "utf8");
      await writeJson(join(rootDir, "config.local.json"), {
        endpoint: "http://127.0.0.1:8420",
        hubEndpoint: `http://127.0.0.1:${server.address().port}`,
        apiKey: "gateway-doctor-token",
        serviceId: "default",
        identity: { userId: "usr-owner", teamId: "team-1", agentId: "agt-1", taskId: "task-1" },
        timeouts: { recallMs: 30, captureMs: 3000 }
      });
      const started = Date.now();
      const checks = await Promise.race([
        runDoctor({ rootDir, deployDir, nodeVersion: "25.2.1", healthCheck: async () => true, gatewayFactory: healthyGateway, metadataClient: healthyMetadata(), hookChecker: async () => true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("doctor did not abort Hub fetch")), 300))
      ]);
      assert.equal(checks.find((check) => check.name === "chat-memory").status, "FAIL");
      assert.ok(Date.now() - started < 300);
    });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
  assert.equal(requests, 1);
});
