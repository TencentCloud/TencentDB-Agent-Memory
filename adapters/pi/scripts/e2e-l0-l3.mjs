#!/usr/bin/env node
/**
 * Real Pi adapter L0-L3 E2E against a running Memory gateway.
 *
 * The test creates an isolated team/agent, seeds real L0 data, waits for
 * MemoryCore's real L1/L2/L3 extraction pipeline, then launches the real Pi CLI
 * with this adapter. A second, temporary observer extension runs after the
 * adapter and checks the final before_agent_start system prompt. Pi never makes
 * an answer-model request; MemoryCore does make real extraction-model requests.
 * No credential or recalled content is printed.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = resolve(SCRIPT_DIR, "..");
const ADAPTER_PATH = join(ADAPTER_DIR, "src", "index.ts");
const PI_ENTRY = join(ADAPTER_DIR, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
let endpoint = process.env.TDAI_MEMORY_ENDPOINT ?? "http://127.0.0.1:8420";
const SERVICE_ID = process.env.TDAI_MEMORY_SERVICE_ID ?? "default";
// The L2 scenario extractor's own LLM deadline is 300s (memory config
// `llm.timeoutMs`); the E2E wait must outlive it or a slow extraction model
// response looks like a pipeline stall. Same budget covers the L3 persona
// generator (180s LLM deadline) plus a comfortable buffer.
const L1_TIMEOUT_MS = Number(process.env.TDAI_E2E_L1_TIMEOUT_MS ?? 180_000);
const L2_TIMEOUT_MS = Number(process.env.TDAI_E2E_L2_TIMEOUT_MS ?? 420_000);
const PI_TIMEOUT_MS = Number(process.env.TDAI_E2E_PI_TIMEOUT_MS ?? 30_000);
const MANAGED_CORE = process.argv.includes("--managed-core");
let activeManagedCore;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function loadUserKey() {
  const direct = process.env.TDAI_MEMORY_USER_KEY;
  if (direct?.trim()) return { key: direct.trim(), file: undefined };
  const file = arg("--key-file") ?? process.env.TDAI_MEMORY_USER_KEY_FILE;
  if (!file) throw new Error("set TDAI_MEMORY_USER_KEY or pass --key-file <path>");
  return { key: (await readFile(resolve(file), "utf8")).trim(), file: resolve(file) };
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
  const temporary = await mkdtemp(join(tmpdir(), "tdai-pi-core-e2e-"));
  const configPath = join(temporary, "tdai-gateway.yaml");
  const container = `tdai-pi-e2e-${process.pid}-${Date.now()}`;
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
    const managedEndpoint = `http://127.0.0.1:${portMatch[1]}`;
    const response = await fetch(`${managedEndpoint}/v3/internal/meta/user/init-admin`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-service-id": SERVICE_ID },
      body: JSON.stringify({ username: `pi-e2e-${process.pid}`, user_key: adminKey }),
    });
    if (!response.ok) throw new Error(`managed MemoryCore init-admin returned HTTP ${response.status}`);
    console.log(`PASS  disposable MemoryCore ready @ ${managedEndpoint}`);
    return { endpoint: managedEndpoint, userKey: adminKey, container, volume, temporary, llmApiKey: llm.apiKey };
  } catch (error) {
    await run("docker", ["rm", "-f", container]).catch(() => {});
    await run("docker", ["volume", "rm", volume]).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function stopManagedCore(core, failed) {
  if (failed) {
    try {
      // Full-log pipeline trace: where did the L1/L2/L3 chain actually stall?
      const logs = await run("docker", ["logs", core.container]);
      const redact = (text) =>
        text
          .replaceAll(core.llmApiKey, "[REDACTED]")
          .replaceAll(/sk-(?:mem-)?[A-Za-z0-9_-]+/gu, "[REDACTED]");
      const pipelineLines = logs.stdout
        .split(/\r?\n/u)
        .filter((line) => /pipeline|extractor|l1|l2|l3|persona|scenario|llm|error|fail|timeout|retry|enqueued/i.test(line))
        .slice(-80);
      if (pipelineLines.length > 0) {
        console.error(`\nManaged MemoryCore pipeline trace (redacted):\n${redact(pipelineLines.join("\n")).slice(-12_000)}`);
      }
      const tail = logs.stdout.split(/\r?\n/u).slice(-80).join("\n");
      console.error(`\nManaged MemoryCore tail (redacted):\n${redact(tail).slice(-12_000)}`);
    } catch {}
  }
  await run("docker", ["rm", "-f", core.container]).catch(() => {});
  await run("docker", ["volume", "rm", core.volume]).catch(() => {});
  await rm(core.temporary, { recursive: true, force: true });
  if (activeManagedCore === core) activeManagedCore = undefined;
}

function mask(value) {
  return value && value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : "<masked>";
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) {
        console.log(`PASS  ${label}`);
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(3_000);
  }
  const suffix = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(`${label} did not become available within ${Math.round(timeoutMs / 1000)}s${suffix}`);
}

async function findScenarioWithMarker(memory, marker) {
  const listed = await memory.listScenarios();
  for (const entry of listed.entries ?? []) {
    const file = await memory.readScenario({ path: entry.path });
    if (file.content?.includes(marker)) return { entry, file };
  }
  return undefined;
}

function containsDeploymentRule(value) {
  const normalized = value?.toLocaleLowerCase() ?? "";
  return normalized.includes("docker compose") && normalized.includes("health");
}

function observerSource() {
  return `
import { writeFile } from "node:fs/promises";

export default function observer(pi) {
  pi.on("before_agent_start", async (event) => {
    const prompt = event.systemPrompt;
    const marker = process.env.TDAI_E2E_MARKER ?? "";
    const labels = ["L3 core", "L1 atomic", "L2 scenario", "L0 conversation"];
    const sections = {};
    for (let index = 0; index < labels.length; index += 1) {
      const start = prompt.indexOf("[" + labels[index] + "]");
      const end = index + 1 < labels.length ? prompt.indexOf("[" + labels[index + 1] + "]", start + 1) : prompt.indexOf("</tdai_recalled_memory>", start + 1);
      sections[labels[index]] = start >= 0 && end > start && prompt.slice(start, end).trim().length > labels[index].length + 2;
    }
    const report = {
      boundary: prompt.includes('<tdai_recalled_memory trust="untrusted" purpose="context-only">'),
      sections,
      promptBytes: Buffer.byteLength(prompt, "utf8"),
      containsMarker: marker.length > 0 && prompt.includes(marker),
    };
    report.ok = report.boundary && report.containsMarker && Object.values(report.sections).every(Boolean);
    await writeFile(process.env.TDAI_E2E_REPORT, JSON.stringify(report), "utf8");
    // Keep this hook pending so Pi cannot begin a provider request. The parent
    // process reads the report and terminates this disposable CLI process.
    await new Promise(() => {});
  });
}
`;
}

async function runPiRecallCheck({ teamId, agentId, userId, key, keyFile, marker, query }) {
  const temporary = await mkdtemp(join(tmpdir(), "tdai-pi-e2e-"));
  const observerPath = join(temporary, "observe-recall.mjs");
  const reportPath = join(temporary, "report.json");
  await writeFile(observerPath, observerSource(), "utf8");

  const args = [
    "--print",
    "--offline",
    "--no-session",
    "--approve",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--provider",
    "openai",
    "--model",
    "gpt-4o-mini",
    "--api-key",
    "e2e-placeholder-not-used",
    "--extension",
    ADAPTER_PATH,
    "--extension",
    observerPath,
    query,
  ];
  const childEnv = {
    ...process.env,
    TDAI_MEMORY_ENDPOINT: endpoint,
    TDAI_MEMORY_SERVICE_ID: SERVICE_ID,
    TDAI_MEMORY_TEAM_ID: teamId,
    TDAI_MEMORY_AGENT_ID: agentId,
    TDAI_MEMORY_USER_ID: userId,
    TDAI_MEMORY_USER_KEY: keyFile ? "" : key,
    TDAI_MEMORY_USER_KEY_FILE: keyFile ?? "",
    TDAI_E2E_MARKER: marker,
    TDAI_E2E_REPORT: reportPath,
    PI_SKIP_VERSION_CHECK: "1",
  };

  try {
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [PI_ENTRY, ...args], {
        cwd: ADAPTER_DIR,
        env: childEnv,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      let report;
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const poll = setInterval(async () => {
        try {
          report = JSON.parse(await readFile(reportPath, "utf8"));
          clearInterval(poll);
          child.kill();
        } catch {}
      }, 50);
      const timer = setTimeout(() => {
        clearInterval(poll);
        child.kill();
        reject(new Error(`Pi recall check timed out after ${Math.round(PI_TIMEOUT_MS / 1000)}s`));
      }, PI_TIMEOUT_MS);
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        clearInterval(poll);
        if (!report) reject(new Error(`Pi exited before producing a recall report (exit=${code})`));
        else resolvePromise({ code, stderr, report });
      });
    });
    const report = result.report;
    if (!report.ok) {
      const safeStderr = result.stderr.replaceAll(/sk-(?:mem-)?[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 500);
      throw new Error(`Pi system-prompt assertion failed (exit=${result.code}, report=${JSON.stringify(report)}, stderr=${safeStderr})`);
    }
    console.log(`PASS  Pi before_agent_start injected L0-L3 (${report.promptBytes} system-prompt bytes)`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  let managedCore;
  let failed = true;
  if (MANAGED_CORE) {
    managedCore = await startManagedCore();
    activeManagedCore = managedCore;
    endpoint = managedCore.endpoint;
  }
  const { key: userKey, file: keyFile } = managedCore
    ? { key: managedCore.userKey, file: undefined }
    : await loadUserKey();
  const stamp = String(Date.now());
  const marker = `ORCHID-${stamp}`;
  const query = `What is the ${marker} docker compose deployment convention?`;
  const metadata = new MetadataClient({ endpoint, apiKey: userKey, serviceId: SERVICE_ID, userKey });
  const verified = await metadata.verifyAuth(userKey);
  if (!verified?.valid || !verified.user?.user_id) throw new Error("user-key verification failed");
  const userId = verified.user.user_id;
  console.log(`PASS  authentication ${mask(userId)} @ ${endpoint}`);

  const team = await metadata.createTeam({ name: `pi-e2e-${stamp}`, owner_user_id: userId });
  const agent = await metadata.createAgent({
    team_id: team.team_id,
    owner_user_id: userId,
    name: `pi-e2e-${stamp}`,
  });
  console.log(`PASS  isolated scope ${mask(team.team_id)} / ${mask(agent.agent_id)}`);

  const memory = new MemoryClient({
    endpoint,
    apiKey: userKey,
    serviceId: SERVICE_ID,
    teamId: team.team_id,
    agentId: agent.agent_id,
    userId,
  });

  try {
    const session = memory.withIsolation({ sessionId: `pi-e2e-${stamp}` });
    const fact = `${marker} is the exact project identifier. Its deployment convention always uses docker compose with a health check before release.`;
    await session.addConversation({
      messages: [
        { role: "user", content: `Remember this durable deployment rule: ${fact}` },
        { role: "assistant", content: `I will preserve the exact identifier and rule: ${fact}` },
        { role: "user", content: `When asked about ${marker}, which deployment tool is mandatory?` },
        { role: "assistant", content: `${marker} must use docker compose and pass its health check.` },
      ],
    });
    await waitFor("L0 conversation search", 30_000, async () => {
      const result = await memory.searchConversation({ query, limit: 10 });
      return result.messages.some((item) => item.content.includes(marker));
    });
    await waitFor("L1 atomic extraction", L1_TIMEOUT_MS, async () => {
      const result = await memory.searchAtomic({ query, limit: 10 });
      return result.items.some((item) => item.content.includes(marker));
    });
    await waitFor("L2 scenario extraction", L2_TIMEOUT_MS, async () => Boolean(await findScenarioWithMarker(memory, marker)));
    // L3 is a distilled operating profile and may intentionally omit the
    // low-level random identifier. Assert the durable rule's semantics rather
    // than requiring L3 to copy L0 verbatim.
    await waitFor("L3 core generation", L2_TIMEOUT_MS, async () => containsDeploymentRule((await memory.readCore()).content));

    await runPiRecallCheck({
      teamId: team.team_id,
      agentId: agent.agent_id,
      userId,
      key: userKey,
      keyFile,
      marker,
      query,
    });
    console.log("\nE2E PASS: real MemoryCore L0-L3 reached the real Pi adapter system prompt.");
    failed = false;
  } finally {
    try {
      await metadata.deleteAgents([agent.agent_id]);
    } catch (error) {
      console.warn(`cleanup warning: agent ${mask(agent.agent_id)} was not removed (${error instanceof Error ? error.message : "unknown"})`);
    }
    try {
      await metadata.deleteTeams([team.team_id]);
    } catch (error) {
      console.warn(`cleanup warning: team ${mask(team.team_id)} was not removed (${error instanceof Error ? error.message : "unknown"})`);
    }
    if (managedCore) await stopManagedCore(managedCore, failed);
  }
}

main().catch(async (error) => {
  if (activeManagedCore) await stopManagedCore(activeManagedCore, true);
  const message = error instanceof Error ? error.message : String(error);
  console.error(`E2E FAIL: ${message.replaceAll(/sk-(?:mem-)?[A-Za-z0-9_-]+/g, "[REDACTED]")}`);
  process.exitCode = 1;
});
