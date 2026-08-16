#!/usr/bin/env node
/**
 * Real-server E2E for the /tdai-memory-setup wizard.
 *
 * `runSetup` is fully interactive, so this driver starts a disposable MemoryCore,
 * seeds a team, and scripts the wizard's `ctx.ui` prompts while keeping the real
 * SDK clients pointed at the live gateway. It exercises the wizard's real
 * identity verification, team/agent listing, private-agent creation, and L0-L3
 * data-plane probe, then asserts the written global config round-trips through
 * `loadConfig` and never contains the secret itself.
 *
 * Usage: npm run e2e:setup -- --env-file deploy/global-images/.env
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

// Node's plain type-stripping does not rewrite the adapter source's relative
// `.js` imports to `.ts`. Install a resolve hook BEFORE the dynamic src imports
// below so `../src/setup.ts` can load its own `./config.js` -> `./config.ts`.
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
const SERVICE_ID = "default";
const CREATE_AGENT_LABEL = "+ Create a private Pi agent";
let activeManagedCore;

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
  const temporary = await mkdtemp(join(tmpdir(), "tdai-pi-setup-e2e-"));
  const configPath = join(temporary, "tdai-gateway.yaml");
  const container = `tdai-pi-setup-e2e-${process.pid}-${Date.now()}`;
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
    await run("docker", [
      "run", "-d", "--rm", "--name", container,
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
    const endpoint = `http://127.0.0.1:${portMatch[1]}`;
    const response = await fetch(`${endpoint}/v3/internal/meta/user/init-admin`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-service-id": SERVICE_ID },
      body: JSON.stringify({ username: `pi-setup-e2e-${process.pid}`, user_key: adminKey }),
    });
    if (!response.ok) throw new Error(`managed MemoryCore init-admin returned HTTP ${response.status}`);
    console.log(`PASS  disposable MemoryCore ready @ ${endpoint}`);
    return { endpoint, userKey: adminKey, container, volume, temporary, llmApiKey: llm.apiKey };
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

function mask(value) {
  return value && value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : "<masked>";
}

/**
 * A scripted Pi UI. `inputs` are returned in call order; the two selects are
 * answered by matching the seeded team/agent id inside the rendered option.
 */
function scriptedUi({ inputs, teamId, agentId, statuses }) {
  let inputIndex = 0;
  return {
    async input() {
      return inputs[inputIndex++];
    },
    async select(title, options) {
      if (title === "Select Memory Team") {
        const option = options.find((entry) => entry.includes(teamId));
        if (!option) throw new Error(`team option not found for ${mask(teamId)} in [${options.join(" | ")}]`);
        return option;
      }
      if (title === "Select Memory Agent") {
        if (agentId === CREATE_AGENT_LABEL) return CREATE_AGENT_LABEL;
        const option = options.find((entry) => entry.includes(agentId));
        if (!option) throw new Error(`agent option not found for ${mask(agentId)} in [${options.join(" | ")}]`);
        return option;
      }
      throw new Error(`unexpected select title: ${title}`);
    },
    setStatus(_key, text) {
      statuses.push(text);
    },
  };
}

async function main() {
  let managedCore;
  let failed = true;
  let cleanupClients;
  const createdAgentIds = [];
  // Loaded lazily so the resolve hook above is already registered.
  const { runSetup } = await import("../src/setup.ts");
  const { loadConfig } = await import("../src/config.ts");
  try {
    managedCore = await startManagedCore();
    activeManagedCore = managedCore;
    const { endpoint, userKey } = managedCore;

    const admin = new MetadataClient({ endpoint, apiKey: userKey, serviceId: SERVICE_ID, userKey });
    cleanupClients = admin;
    const verified = await admin.verifyAuth(userKey);
    if (!verified?.valid || !verified.user?.user_id) throw new Error("user-key verification failed");
    const userId = verified.user.user_id;
    const stamp = String(Date.now());
    const team = await admin.createTeam({ name: `pi-setup-e2e-${stamp}`, owner_user_id: userId });
    console.log(`PASS  seeded team ${mask(team.team_id)} / admin ${mask(userId)}`);

    // Working dir holds the key file; agent dir receives the global config.
    const cwd = await mkdtemp(join(tmpdir(), "tdai-setup-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "tdai-setup-agentdir-"));
    await writeFile(join(cwd, "admin.key"), userKey, { encoding: "utf8", mode: 0o600 });
    const statuses = [];

    // Scenario 1: create a private Pi agent, real data-plane probe, config written.
    const createUi = scriptedUi({
      inputs: [endpoint, SERVICE_ID, "admin.key", "", "Pi E2E Agent"],
      teamId: team.team_id,
      agentId: CREATE_AGENT_LABEL,
      statuses,
    });
    const created = await runSetup(
      { cwd, hasUI: true, ui: createUi },
      { agentDir },
    );
    if (!created.ok || !created.createdAgent) {
      throw new Error(`create-agent setup expected ok+createdAgent, got ${JSON.stringify(created)}`);
    }
    const configPath = resolve(created.configPath);
    if (!configPath.startsWith(resolve(agentDir))) {
      throw new Error(`setup wrote config outside the injected agent dir: ${configPath}`);
    }
    const written = JSON.parse(await readFile(configPath, "utf8"));
    if (written.endpoint !== endpoint || written.teamId !== team.team_id || written.userId !== userId) {
      throw new Error(`config endpoint/team/user mismatch: ${JSON.stringify(written)}`);
    }
    if (JSON.stringify(written).includes(userKey)) {
      throw new Error("global config must not embed the secret key (only its path)");
    }
    createdAgentIds.push(written.agentId);
    const reloaded = await loadConfig({ cwd, projectTrusted: false, agentDir, env: {} });
    if (!reloaded.ok || !reloaded.config.enabled) {
      throw new Error(`loadConfig could not activate the setup config: ${JSON.stringify(reloaded.errors)}`);
    }
    if (reloaded.config.endpoint !== endpoint || reloaded.config.teamId !== team.team_id || reloaded.config.agentId !== written.agentId) {
      throw new Error("loadConfig did not round-trip the setup config identity");
    }
    const agentsNow = await admin.listAgents({ team_id: team.team_id, status: "active", limit: 100, offset: 0 });
    if (!agentsNow.items.some((agent) => agent.agent_id === written.agentId)) {
      throw new Error("the setup-created agent is not visible on the server");
    }
    console.log(`PASS  setup created a private agent ${mask(written.agentId)}, config round-trips, no key embedded`);

    // Scenario 2: pre-seeded agent is selectable without creating another.
    const preAgent = await admin.createAgent({
      team_id: team.team_id,
      owner_user_id: userId,
      name: `pi-setup-e2e-preseed-${stamp}`,
      description: "preselected agent",
      visibility: "private",
      status: "active",
    });
    const selectUi = scriptedUi({
      inputs: [endpoint, SERVICE_ID, "admin.key", ""],
      teamId: team.team_id,
      agentId: preAgent.agent_id,
      statuses,
    });
    const selected = await runSetup({ cwd, hasUI: true, ui: selectUi }, { agentDir });
    if (!selected.ok || selected.createdAgent) {
      throw new Error(`select-agent setup expected ok+not-created, got ${JSON.stringify(selected)}`);
    }
    const selectedConfig = JSON.parse(await readFile(selected.configPath, "utf8"));
    if (selectedConfig.agentId !== preAgent.agent_id) {
      throw new Error(`select-agent setup wrote the wrong agent: ${selectedConfig.agentId}`);
    }
    console.log(`PASS  setup reused the preselected agent ${mask(preAgent.agent_id)}`);

    // Scenario 3: a wrong key fails real identity verification (no crash).
    await writeFile(join(cwd, "bad.key"), `sk-definitely-not-valid-${randomBytes(8).toString("base64url")}`, "utf8");
    const badKeyUi = scriptedUi({
      inputs: [endpoint, SERVICE_ID, "bad.key", ""],
      teamId: team.team_id,
      agentId: CREATE_AGENT_LABEL,
      statuses,
    });
    const badKey = await runSetup({ cwd, hasUI: true, ui: badKeyUi }, { agentDir });
    if (badKey.ok || badKey.cancelled || !badKey.message.includes("User key verification failed")) {
      throw new Error(`bad-key setup expected a verification failure, got ${JSON.stringify(badKey)}`);
    }
    console.log("PASS  wrong key is rejected by real identity verification");

    // Scenario 4: cancelling the wizard returns cancelled without writing.
    const cancelUi = scriptedUi({
      inputs: [undefined],
      teamId: team.team_id,
      agentId: CREATE_AGENT_LABEL,
      statuses,
    });
    const cancelled = await runSetup({ cwd, hasUI: true, ui: cancelUi }, { agentDir });
    if (cancelled.ok || !cancelled.cancelled) {
      throw new Error(`cancel setup expected cancelled, got ${JSON.stringify(cancelled)}`);
    }
    console.log("PASS  cancelling the wizard is clean");

    console.log("\nE2E PASS: /tdai-memory-setup works end-to-end against a real MemoryCore.");
    failed = false;
  } finally {
    try {
      if (cleanupClients && createdAgentIds.length > 0) {
        await cleanupClients.deleteAgents(createdAgentIds).catch(() => {});
      }
    } catch {}
    if (managedCore) {
      try {
        const { endpoint, userKey } = managedCore;
        const cleanup = new MetadataClient({ endpoint, apiKey: userKey, serviceId: SERVICE_ID, userKey });
        const teamList = await cleanup.listTeams({ user_id: "", limit: 100, offset: 0 }).catch(() => ({ items: [] }));
        for (const teamEntry of teamList.items ?? []) {
          if (!teamEntry.team_id.startsWith("team-")) continue;
          const agents = await cleanup.listAgents({ team_id: teamEntry.team_id, status: "active", limit: 500, offset: 0 }).catch(() => ({ items: [] }));
          const agentIds = (agents.items ?? []).map((entry) => entry.agent_id);
          if (agentIds.length > 0) await cleanup.deleteAgents(agentIds).catch(() => {});
          await cleanup.deleteTeams([teamEntry.team_id]).catch(() => {});
        }
      } catch {}
      await stopManagedCore(managedCore);
    }
  }
}

main().catch(async (error) => {
  if (activeManagedCore) await stopManagedCore(activeManagedCore);
  const message = error instanceof Error ? error.message : String(error);
  console.error(`E2E FAIL: ${message.replaceAll(/sk-(?:mem-)?[A-Za-z0-9_-]+/gu, "[REDACTED]")}`);
  process.exitCode = 1;
});
