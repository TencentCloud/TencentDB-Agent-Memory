#!/usr/bin/env node
/**
 * Real-Pi E2E for the adapter's durability guarantees: reload, fork, and
 * outage recovery. All three run the actual Pi 0.84.1 binary in RPC mode with
 * the adapter extension loaded, against a disposable MemoryCore:
 *
 *   A. reload must not re-capture a settled turn.
 *      A fabricated persisted session is opened by the real Pi. We pre-seed the
 *      filesystem outbox with one record (a capture that was queued but not yet
 *      flushed), then watch a fresh Pi process flush it exactly once. Restarting
 *      Pi on the same session must not produce a second delivery and must not
 *      re-run agent_settled (Pi emits only session_start/session_shutdown on
 *      load; the adapter's run-context gating is the second line of defense).
 *
 *   B. RPC fork keeps branch isolation.
 *      The same fabricated session carries a `tdai-memory/branch@1` marker at
 *      its root. The RPC `fork {entryId}` command drives the real runtime
 *      `fork()` -> SessionManager.createBranchedSession. We assert the forked
 *      session file has a new session id, records the source as parentSession,
 *      preserves the branch marker (so the adapter's restoreBranchId keeps the
 *      same branch id), and that the derived memory session id therefore
 *      differs from the parent's.
 *
 *   C. outage then recovery never loses or duplicates a capture.
 *      MemoryCore is stopped while an undelivered capture is queued. Pi must
 *      still come up (fail-open) and the capture must stay pending on disk.
 *      Once the service is restarted, a fresh Pi delivers it exactly once, and
 *      a further restart delivers nothing new.
 *
 * Usage: npm run e2e:lifecycle -- --env-file deploy/global-images/.env
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MemoryClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

// Same trick as e2e-setup.mjs: plain node does not rewrite the adapter source's
// relative `.js` imports to `.ts`. Install the resolve hook before the dynamic
// src imports below.
register(
  `data:text/javascript,${encodeURIComponent(
    "export async function resolve(s, c, n) {\n" +
      "  if (s.startsWith('.') && s.endsWith('.js')) {\n" +
      "    const t = new URL(s.slice(0, -3) + '.ts', c.parentURL);\n" +
      "    try { return await n(t.href, c); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }\n" +
      "  }\n" +
      "  return n(s, c);\n" +
      "}\n",
  )}`,
  import.meta.url,
);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = resolve(SCRIPT_DIR, "..");
const PI_ENTRY = join(ADAPTER_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const SERVICE_ID = "default";
let activeManagedCore;
let activeChildren = [];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseEnvFile(raw) {
  const parsed = {};
  for (const line of raw.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

async function loadLlmConfig() {
  const file = arg("--env-file");
  const fromFile = file ? parseEnvFile(await readFile(resolve(file), "utf8")) : {};
  const value = (name) => process.env[name]?.trim() || fromFile[name]?.trim();
  const config = {
    baseUrl: value("MEMORY_LLM_BASE_URL"),
    apiKey: value("MEMORY_LLM_API_KEY"),
    model: value("MEMORY_LLM_MODEL"),
    image: value("MEMORY_CORE_IMAGE") || "agentmemory/memory-core:latest",
  };
  for (const [name, item] of [
    ["MEMORY_LLM_BASE_URL", config.baseUrl],
    ["MEMORY_LLM_API_KEY", config.apiKey],
    ["MEMORY_LLM_MODEL", config.model],
  ]) {
    if (!item || item === "REPLACE_ME") throw new Error(`managed core requires ${name} via environment or --env-file`);
  }
  return config;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitForCore(container, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", container]);
    if (status.stdout.trim() === "healthy") return;
    if (["exited", "dead"].includes(status.stdout.trim())) throw new Error(`managed MemoryCore became ${status.stdout.trim()}`);
    await sleep(2_000);
  }
  throw new Error("managed MemoryCore did not become healthy within 90s");
}

async function startManagedCore() {
  const llm = await loadLlmConfig();
  const temporary = await mkdtemp(join(tmpdir(), "tdai-pi-lifecycle-e2e-"));
  const configPath = join(temporary, "tdai-gateway.yaml");
  const container = `tdai-pi-lifecycle-e2e-${process.pid}-${Date.now()}`;
  const volume = `${container}-data`;
  const adminKey = `sk-mem-${randomBytes(24).toString("base64url")}`;
  const yaml = `deployMode: standalone
stateBackend: local
server: { port: 8420, host: 0.0.0.0 }
data: { baseDir: /data/tdai-memory }
llm:
  baseUrl: ${JSON.stringify(llm.baseUrl)}
  apiKey: ${JSON.stringify(llm.apiKey)}
  model: ${JSON.stringify(llm.model)}
  maxTokens: 32000
  timeoutMs: 300000
memory:
  promptMode: code
  capture: { enabled: true }
  extraction: { enabled: true, enableDedup: true, maxMemoriesPerSession: 20 }
  persona: { triggerEveryN: 1, maxScenes: 15 }
  pipeline:
    everyNConversations: 1
    enableWarmup: false
    l1IdleTimeoutSeconds: 10
    l2DelayAfterL1Seconds: 2
    l2MinIntervalSeconds: 1
    l2MaxIntervalSeconds: 30
  recall: { enabled: true, maxResults: 8, scoreThreshold: 0.1, strategy: hybrid, timeoutMs: 5000 }
  storeBackend: sqlite
  embedding: { provider: none }
  skill: { enabled: false }
`;
  await writeFile(configPath, yaml, { encoding: "utf8", mode: 0o600 });
  try {
    await run("docker", ["volume", "create", volume]);
    // No --rm: Phase C removes and re-creates this container on the same volume
    // and host port to simulate a restart (stop/start can lose the auto-assigned
    // host port binding on Docker Desktop). stopManagedCore still removes it
    // explicitly at teardown.
    await run("docker", [
      "run", "-d", "--name", container,
      "-p", "127.0.0.1::8420",
      "--mount", `type=volume,source=${volume},target=/data/tdai-memory`,
      "--mount", `type=bind,source=${configPath},target=/data/config/tdai-gateway.yaml,readonly`,
      "-e", "TDAI_GATEWAY_PORT=8420",
      "-e", "TDAI_GATEWAY_HOST=0.0.0.0",
      "-e", "TDAI_DATA_DIR=/data/tdai-memory",
      llm.image,
    ]);
    await waitForCore(container);
    const portResult = await run("docker", ["port", container, "8420/tcp"]);
    const portMatch = portResult.stdout.match(/127\.0\.0\.1:(\d+)/u);
    if (!portMatch) throw new Error("could not resolve managed MemoryCore port");
    const hostPort = portMatch[1];
    const endpoint = `http://127.0.0.1:${hostPort}`;
    const response = await fetch(`${endpoint}/v3/internal/meta/user/init-admin`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-service-id": SERVICE_ID },
      body: JSON.stringify({ username: `pi-lifecycle-e2e-${process.pid}`, user_key: adminKey }),
    });
    if (!response.ok) throw new Error(`managed MemoryCore init-admin returned HTTP ${response.status}`);
    console.log(`PASS  disposable MemoryCore ready @ ${endpoint}`);
    return { endpoint, hostPort, image: llm.image, userKey: adminKey, container, volume, temporary, llmApiKey: llm.apiKey };
  } catch (error) {
    await run("docker", ["rm", "-f", container]).catch(() => {});
    await run("docker", ["volume", "rm", volume]).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function stopManagedCore(core) {
  await run("docker", ["rm", "-f", core.container]).catch(() => {});
  await run("docker", ["volume", "rm", core.volume]).catch(() => {});
  await rm(core.temporary, { recursive: true, force: true });
  if (activeManagedCore === core) activeManagedCore = undefined;
}

/**
 * "Restart" the managed MemoryCore after an outage. The outage is simulated by
 * removing the container, so recovery re-creates it on the same named volume
 * (data and admin identity persist) and the same pinned host port (the endpoint
 * and scope stay identical). Re-creating from scratch is deliberate: `docker
 * stop`/`start` on Docker Desktop can leave the auto-assigned host port binding
 * dead even while the container reports healthy, which would make the endpoint
 * unreachable exactly when the test needs it back.
 */
async function restartManagedCore(core) {
  const configPath = join(core.temporary, "tdai-gateway.yaml");
  await run("docker", [
    "run", "-d", "--name", core.container,
    "-p", `127.0.0.1:${core.hostPort}:8420`,
    "--mount", `type=volume,source=${core.volume},target=/data/tdai-memory`,
    "--mount", `type=bind,source=${configPath},target=/data/config/tdai-gateway.yaml,readonly`,
    "-e", "TDAI_GATEWAY_PORT=8420",
    "-e", "TDAI_GATEWAY_HOST=0.0.0.0",
    "-e", "TDAI_DATA_DIR=/data/tdai-memory",
    core.image,
  ]);
  await waitForCore(core.container);
}

function mask(value) {
  return value && value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : "<masked>";
}

function maskOutput(text) {
  return text.replaceAll(/sk-(?:mem-)?[A-Za-z0-9_-]+/gu, "[REDACTED]");
}

/** Structurally valid Pi user message. */
function userMessage(content) {
  return { role: "user", content, timestamp: Date.now() };
}

/** Structurally valid Pi assistant message; its presence makes the file durable. */
function assistantMessage(content) {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "anthropic",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Spawn the real Pi binary in RPC mode on a concrete session file, with the
 * adapter extension loaded and an isolated agent dir. Returns { child, events,
 * send } where send() resolves with the command response.
 */
function startPi({ sessionFile, sessionDir, cwd, agentDir, startupTimeoutMs = 60_000 }) {
  const childEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Never leak a host TDAI_MEMORY_* credential into the managed-core run.
    if (key.startsWith("TDAI_MEMORY_")) continue;
    childEnv[key] = value;
  }
  childEnv.PI_CODING_AGENT_DIR = agentDir;

  const child = spawn(
    process.execPath,
    [
      PI_ENTRY,
      "--mode", "rpc",
      "--offline",
      "--session", sessionFile,
      "--session-dir", sessionDir,
      "-e", ADAPTER_ROOT,
    ],
    { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
  );
  activeChildren.push(child);

  const events = [];
  let buffer = "";
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "response") {
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          if (message.success) waiter.resolve(message);
          else waiter.reject(new Error(`${message.command} failed: ${message.error}`));
        }
      } else {
        events.push(message);
      }
    }
  });

  const send = (id, type, payload = {}) =>
    new Promise((resolvePromise, reject) => {
      pending.set(id, { resolve: resolvePromise, reject });
      child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
    });

  const ready = () =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("Pi did not answer get_state in time")), startupTimeoutMs);
      send("lifecycle-ready", "get_state").then((result) => {
        clearTimeout(timer);
        resolvePromise(result);
      }).catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

  return { child, events, send, ready };
}

async function stopPi(handle) {
  try {
    handle.child.stdin.end();
  } catch {}
  await Promise.race([
    new Promise((resolvePromise) => handle.child.once("exit", resolvePromise)),
    sleep(5_000),
  ]).catch(() => {});
  try {
    handle.child.kill();
  } catch {}
  activeChildren = activeChildren.filter((entry) => entry !== handle.child);
}

async function outboxEntries(agentDir) {
  const directory = join(agentDir, "tdai-memory-outbox");
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".json") || name.includes(".json.lease-"));
}

async function waitForFlush(agentDir, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = await outboxEntries(agentDir);
    if (remaining.length === 0) return;
    await sleep(500);
  }
  const remaining = await outboxEntries(agentDir);
  throw new Error(`outbox did not drain within ${timeoutMs}ms; remaining: ${remaining.join(", ")}`);
}

async function queryConversationMessages(endpoint, identity, sessionId) {
  const memory = new MemoryClient({
    endpoint,
    apiKey: identity.userKey,
    serviceId: SERVICE_ID,
    timeout: 5_000,
    rejectUnauthorized: true,
    teamId: identity.teamId,
    agentId: identity.agentId,
    userId: identity.userId,
  });
  // Mirror the adapter's read path (createSessionMemoryClient) so the query is
  // scoped to the same isolated session.
  return memory.withIsolation({ sessionId }).queryConversation();
}

/**
 * Phase C — outage then recovery. Stop MemoryCore while a capture is still
 * queued, prove Pi keeps working (fail-open) and the record stays pending, then
 * restart the service and prove a fresh Pi delivers it exactly once - and a
 * further restart delivers nothing new.
 */
async function runOfflineRecovery({ managedCore, endpoint, identity, userKey, cleanupDirs }) {
  const { loadConfig } = await import("../src/config.ts");
  const { enqueueCapture } = await import("../src/outbox.ts");
  const { BRANCH_ENTRY_TYPE, memorySessionId } = await import("../src/session.ts");

  // Dedicated session so this phase's memory scope starts empty.
  const sessionCwd = await mkdtemp(join(tmpdir(), "tdai-recovery-cwd-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "tdai-recovery-sessions-"));
  const agentDir = await mkdtemp(join(tmpdir(), "tdai-recovery-agentdir-"));
  cleanupDirs.push(sessionCwd, sessionDir, agentDir);

  const fabricated = SessionManager.create(sessionCwd, sessionDir);
  const branchId = `branch-recovery-${randomBytes(4).toString("hex")}`;
  fabricated.appendCustomEntry(BRANCH_ENTRY_TYPE, { branchId, createdAt: new Date().toISOString() });
  fabricated.appendMessage(userMessage("offline origin turn"));
  fabricated.appendMessage(assistantMessage("offline origin reply"));
  const sessionFile = fabricated.getSessionFile();
  const sessionId = fabricated.getSessionId();
  if (!sessionFile) throw new Error("recovery session was not persisted");

  await writeFile(join(agentDir, "user.key"), userKey, { encoding: "utf8", mode: 0o600 });
  await writeFile(
    join(agentDir, "tdai-memory.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        enabled: true,
        endpoint,
        serviceId: SERVICE_ID,
        teamId: identity.teamId,
        agentId: identity.agentId,
        userId: identity.userId,
        userKeyFile: "user.key",
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const recoveryMemoryId = memorySessionId(sessionId, branchId);

  // The service is down before the capture is made, so the local outbox is the
  // only place the record can live until Memory comes back. Removing the
  // container drops the host port binding immediately (ECONNREFUSED), so the
  // offline flush fails fast and restores the record cleanly.
  console.log("→ stopping MemoryCore to simulate an outage");
  await run("docker", ["rm", "-f", managedCore.container]);

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const config = await loadConfig({ cwd: sessionCwd, projectTrusted: false, agentDir, env: {} });
    if (!config.ok || !config.config.enabled) {
      throw new Error(`recovery config did not load: ${JSON.stringify(config.errors)}`);
    }
    await enqueueCapture(config.config, recoveryMemoryId, [
      { role: "user", content: "offline origin turn" },
      { role: "assistant", content: "offline origin reply" },
    ]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }

  // Pi starts against a dead service: the flush fails open, so Pi still answers
  // and the record stays pending for the next time the service is reachable.
  const piOffline = startPi({ sessionFile, sessionDir, cwd: sessionCwd, agentDir });
  await piOffline.ready();
  await sleep(1_500); // let the failed flush restore the record with a retry backoff
  const pending = await outboxEntries(agentDir);
  if (pending.length !== 1) {
    throw new Error(`expected 1 pending capture while Memory is down, got ${pending.length}: ${pending.join(", ")}`);
  }
  console.log("PASS  Pi answers while Memory is down and the capture stays pending in the outbox");
  await stopPi(piOffline);

  // Bring the service back (same volume, same host port), let the retry
  // backoff elapse, then flush.
  await restartManagedCore(managedCore);
  await sleep(1_500);

  const piRecover = startPi({ sessionFile, sessionDir, cwd: sessionCwd, agentDir });
  await piRecover.ready();
  await waitForFlush(agentDir);
  await sleep(1_000); // grace for any duplicate delivery
  const afterRecover = await queryConversationMessages(endpoint, identity, recoveryMemoryId);
  if (afterRecover.total !== 2 || afterRecover.messages.length !== 2) {
    throw new Error(`expected exactly one 2-message capture after recovery, got total=${afterRecover.total}`);
  }
  if ((await outboxEntries(agentDir)).length !== 0) throw new Error("outbox was not drained after recovery");
  console.log("PASS  after Memory returns, a fresh Pi delivers the pending capture exactly once");
  await stopPi(piRecover);

  // Restart the same session again: nothing may be delivered a second time.
  const piAgain = startPi({ sessionFile, sessionDir, cwd: sessionCwd, agentDir });
  await piAgain.ready();
  await sleep(2_000);
  const afterAgain = await queryConversationMessages(endpoint, identity, recoveryMemoryId);
  if (afterAgain.total !== 2) {
    throw new Error(`reload after recovery re-delivered: expected 2 messages, got total=${afterAgain.total}`);
  }
  console.log("PASS  a further restart delivers nothing new");
  await stopPi(piAgain);
}

async function main() {
  let managedCore;
  let failed = true;
  const cleanupDirs = [];
  let createdTeamId;
  let createdAgentId;
  let metadataClient;

  // Loaded lazily so the resolve hook above is already registered.
  const { loadConfig } = await import("../src/config.ts");
  const { enqueueCapture } = await import("../src/outbox.ts");
  const { BRANCH_ENTRY_TYPE, memorySessionId, restoreBranchId } = await import("../src/session.ts");

  try {
    if (!PI_ENTRY || !(await stat(PI_ENTRY).catch(() => undefined))) {
      throw new Error("Pi development dependency is missing. Run npm ci first.");
    }

    managedCore = await startManagedCore();
    activeManagedCore = managedCore;
    const { endpoint, userKey } = managedCore;

    metadataClient = new MetadataClient({ endpoint, apiKey: userKey, serviceId: SERVICE_ID, userKey });
    const verified = await metadataClient.verifyAuth(userKey);
    if (!verified?.valid || !verified.user?.user_id) throw new Error("user-key verification failed");
    const userId = verified.user.user_id;
    const stamp = String(Date.now());
    const team = await metadataClient.createTeam({ name: `pi-lifecycle-${stamp}`, owner_user_id: userId });
    createdTeamId = team.team_id;
    const agent = await metadataClient.createAgent({
      team_id: team.team_id,
      owner_user_id: userId,
      name: `pi-lifecycle-agent-${stamp}`,
      description: "pi lifecycle e2e",
      visibility: "private",
      status: "active",
    });
    createdAgentId = agent.agent_id;
    console.log(`PASS  seeded team ${mask(createdTeamId)} / agent ${mask(createdAgentId)}`);

    // ---- Fabricate a persisted session with a branch marker at its root ----
    const sessionCwd = await mkdtemp(join(tmpdir(), "tdai-lifecycle-cwd-"));
    const sessionDir = await mkdtemp(join(tmpdir(), "tdai-lifecycle-sessions-"));
    const agentDir = await mkdtemp(join(tmpdir(), "tdai-lifecycle-agentdir-"));
    cleanupDirs.push(sessionCwd, sessionDir, agentDir);

    const fabricated = SessionManager.create(sessionCwd, sessionDir);
    const branchId = `branch-e2e-${randomBytes(4).toString("hex")}`;
    fabricated.appendCustomEntry(BRANCH_ENTRY_TYPE, { branchId, createdAt: new Date().toISOString() });
    fabricated.appendMessage(userMessage("origin turn"));
    fabricated.appendMessage(assistantMessage("origin reply"));
    const forkTargetUser = fabricated.appendMessage(userMessage("follow-up turn"));
    fabricated.appendMessage(assistantMessage("follow-up reply"));
    const sessionFile = fabricated.getSessionFile();
    const sessionId = fabricated.getSessionId();
    if (!sessionFile || !forkTargetUser) throw new Error("fabricated session was not persisted");

    // ---- Isolated adapter config in the injected agent dir ----
    await writeFile(join(agentDir, "user.key"), userKey, { encoding: "utf8", mode: 0o600 });
    await writeFile(
      join(agentDir, "tdai-memory.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enabled: true,
          endpoint,
          serviceId: SERVICE_ID,
          teamId: createdTeamId,
          agentId: createdAgentId,
          userId,
          userKeyFile: "user.key",
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    // Pre-seed the outbox with one undelivered capture, exactly as the adapter
    // would have queued it before the process "died". Must use the same config
    // scope the real Pi process will load so the flush matches it.
    // Point the DRIVER's getAgentDir() at the temp agent dir as well: the Pi
    // child already gets PI_CODING_AGENT_DIR, and enqueueCapture resolves the
    // outbox through the same env in this process.
    const memorySessionIdForRoot = memorySessionId(sessionId, branchId);
    const identity = { userKey, teamId: createdTeamId, agentId: createdAgentId, userId };
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const preseedConfig = await loadConfig({ cwd: sessionCwd, projectTrusted: false, agentDir, env: {} });
      if (!preseedConfig.ok || !preseedConfig.config.enabled) {
        throw new Error(`pre-seed config did not load: ${JSON.stringify(preseedConfig.errors)}`);
      }
      await enqueueCapture(preseedConfig.config, memorySessionIdForRoot, [
        { role: "user", content: "origin turn" },
        { role: "assistant", content: "origin reply" },
      ]);
      if ((await outboxEntries(agentDir)).length !== 1) {
        throw new Error("pre-seeded record did not land in the expected outbox directory");
      }
      console.log(`PASS  outbox pre-seeded with one undelivered capture for ${mask(memorySessionIdForRoot)}`);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }

    // ---- Phase A: reload must not duplicate the pre-seeded capture ----
    const piOne = startPi({ sessionFile, sessionDir, cwd: sessionCwd, agentDir });
    await piOne.ready();
    await waitForFlush(agentDir);
    await sleep(1_500); // grace: any spurious re-enqueue / second delivery would surface here
    const afterOne = await queryConversationMessages(endpoint, identity, memorySessionIdForRoot);
    if (afterOne.total !== 2 || afterOne.messages.length !== 2) {
      throw new Error(`expected exactly one 2-message capture after first start, got total=${afterOne.total}`);
    }
    if (await outboxEntries(agentDir).then((entries) => entries.length) !== 0) {
      throw new Error("outbox was not drained after the first start");
    }
    const settledAfterOne = piOne.events.filter((event) => event.type === "agent_settled");
    if (settledAfterOne.length !== 0) {
      throw new Error(`Pi replayed agent_settled on load (${settledAfterOne.length}); the first defense failed`);
    }
    console.log("PASS  fresh Pi flushed the pre-seeded capture exactly once (no replay, no duplicate)");
    await stopPi(piOne);

    // Restart the same session: nothing should be delivered again.
    const piTwo = startPi({ sessionFile, sessionDir, cwd: sessionCwd, agentDir });
    await piTwo.ready();
    await sleep(2_000); // let any (correctly absent) flush attempt surface
    const afterTwo = await queryConversationMessages(endpoint, identity, memorySessionIdForRoot);
    if (afterTwo.total !== 2) {
      throw new Error(`reload re-captured the turn: expected still 2 messages, got total=${afterTwo.total}`);
    }
    const settledAfterTwo = piTwo.events.filter((event) => event.type === "agent_settled");
    if (settledAfterTwo.length !== 0) {
      throw new Error(`Pi replayed agent_settled on reload (${settledAfterTwo.length})`);
    }
    console.log("PASS  reloading the session delivers nothing new (outbox empty, memory unchanged)");
    await stopPi(piTwo);

    // ---- Phase B: RPC fork keeps branch isolation ----
    const piThree = startPi({ sessionFile, sessionDir, cwd: sessionCwd, agentDir });
    const stateBefore = await piThree.ready();
    const entries = await piThree.send("lifecycle-entries", "get_entries");
    const userEntries = entries.data.entries.filter(
      (entry) => entry.type === "message" && entry.message?.role === "user",
    );
    const forkTarget = userEntries[userEntries.length - 1];
    if (!forkTarget) throw new Error("no user entry to fork on");

    const forkResponse = await piThree.send("lifecycle-fork", "fork", { entryId: forkTarget.id });
    if (forkResponse.data.cancelled) throw new Error("RPC fork was cancelled");
    if (forkResponse.data.text !== "follow-up turn") {
      throw new Error(`fork selected unexpected text: ${JSON.stringify(forkResponse.data.text)}`);
    }
    const stateAfter = await piThree.send("lifecycle-state", "get_state");
    const forkedSessionFile = stateAfter.data.sessionFile;
    const forkedSessionId = stateAfter.data.sessionId;
    if (forkedSessionFile === stateBefore.data.sessionFile) throw new Error("fork did not switch session file");
    if (forkedSessionId === sessionId) throw new Error("fork did not create a new session id");
    if (!forkedSessionFile || !forkedSessionId) throw new Error("forked session state missing session id/file");

    // Inspect the forked file through the real SessionManager, exactly as the
    // adapter's restoreBranchId would on the next session_start.
    const reopened = SessionManager.open(forkedSessionFile, sessionDir);
    const restoredBranch = restoreBranchId(reopened.getBranch());
    if (reopened.getHeader()?.parentSession !== sessionFile) {
      throw new Error(`forked session does not record the source as parent: ${reopened.getHeader()?.parentSession}`);
    }
    if (restoredBranch !== branchId) {
      throw new Error(`branch marker not preserved across fork: expected ${mask(branchId)}, got ${mask(restoredBranch)}`);
    }
    const parentMemoryId = memorySessionId(sessionId, branchId);
    const forkedMemoryId = memorySessionId(forkedSessionId, branchId);
    if (parentMemoryId === forkedMemoryId) {
      throw new Error("forked memory session id must differ from the parent's");
    }
    console.log(
      `PASS  RPC fork -> new session ${mask(forkedSessionId)}, parent recorded, branch marker preserved (` +
        `${mask(parentMemoryId)} -> ${mask(forkedMemoryId)})`,
    );
    await stopPi(piThree);

    // ---- Phase C: outage then recovery never loses or duplicates a capture ----
    await runOfflineRecovery({ managedCore, endpoint, identity, userKey, cleanupDirs });

    console.log(
      "\nE2E PASS: real-Pi reload stays duplicate-free, RPC fork keeps branch isolation, " +
        "and an outage never loses or duplicates a capture.",
    );
    failed = false;
  } finally {
    for (const child of activeChildren.splice(0)) {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    }
    try {
      if (metadataClient && createdAgentId) await metadataClient.deleteAgents([createdAgentId]).catch(() => {});
      if (metadataClient && createdTeamId) await metadataClient.deleteTeams([createdTeamId]).catch(() => {});
    } catch {}
    await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    if (managedCore) await stopManagedCore(managedCore);
  }
}

main().catch(async (error) => {
  for (const child of activeChildren.splice(0)) {
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
  }
  if (activeManagedCore) await stopManagedCore(activeManagedCore);
  const message = error instanceof Error ? error.message : String(error);
  console.error(`E2E FAIL: ${maskOutput(message)}`);
  process.exitCode = 1;
});
