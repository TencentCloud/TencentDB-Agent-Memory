#!/usr/bin/env node
/**
 * Real Pi adapter Skill E2E against a running Memory gateway.
 *
 * Verifies the full Skill closed loop end to end:
 *   1. the server accepts the adapter's five-role conversation shape
 *      (conversation/add -> force-archive -> async extraction);
 *   2. the extracted skill becomes searchable;
 *   3. the real Pi adapter injects that skill into its recall system prompt
 *      as an untrusted fifth layer.
 *
 * MemoryCore makes real extraction-model requests (the LLM config must be
 * provided via --env-file or the MEMORY_LLM_* environment); Pi itself never
 * makes an answer-model request. No credential or recalled content is printed.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MetadataClient, SkillClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { installSyncedSkill } from "../src/skill-sync.ts";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = resolve(SCRIPT_DIR, "..");
const ADAPTER_PATH = join(ADAPTER_DIR, "src", "index.ts");
const PI_ENTRY = join(ADAPTER_DIR, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
let endpoint = process.env.TDAI_MEMORY_ENDPOINT ?? "http://127.0.0.1:8420";
const SERVICE_ID = process.env.TDAI_MEMORY_SERVICE_ID ?? "default";
// Skill extraction is a multi-turn LLM review; budget it like the L1 extractor.
const SKILL_EXTRACT_TIMEOUT_MS = Number(process.env.TDAI_E2E_SKILL_TIMEOUT_MS ?? 180_000);
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
  const temporary = await mkdtemp(join(tmpdir(), "tdai-pi-skill-e2e-"));
  const configPath = join(temporary, "tdai-gateway.yaml");
  const container = `tdai-pi-skill-e2e-${process.pid}-${Date.now()}`;
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
skill:
  enabled: true
  storeBackend: sqlite
  contentBackend: local
  routing:
    mode: bm25
  extraction:
    enabled: true
    maxIterations: 16
    toolCallThreshold: 1
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
      body: JSON.stringify({ username: `pi-skill-e2e-${process.pid}`, user_key: adminKey }),
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
      const logs = await run("docker", ["logs", core.container]);
      const redact = (text) =>
        text
          .replaceAll(core.llmApiKey, "[REDACTED]")
          .replaceAll(/sk-(?:mem-)?[A-Za-z0-9_-]+/gu, "[REDACTED]");
      const skillLines = logs.stdout
        .split(/\r?\n/u)
        .filter((line) => /dequeue|consume|extract|archive|review|enqueue|task|llm|error|fail|timeout|ghost|worker|candidate/i.test(line))
        .slice(-120);
      if (skillLines.length > 0) {
        console.error(`\nManaged MemoryCore skill trace (redacted):\n${redact(skillLines.join("\n")).slice(-12_000)}`);
      }
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

function observerSource() {
  return `
import { writeFile } from "node:fs/promises";

export default function observer(pi) {
  pi.on("before_agent_start", async (event) => {
    const prompt = event.systemPrompt;
    const marker = process.env.TDAI_E2E_MARKER ?? "";
    const buildRule = process.env.TDAI_E2E_BUILD_RULE ?? "";
    const start = prompt.indexOf("[Skill]");
    const end = prompt.indexOf("</tdai_recalled_memory>", start + 1);
    const section = start >= 0 && end > start ? prompt.slice(start, end) : "";
    const skillSection = section.trim().length > "[Skill]".length + 2;
    // The extractor may keep the concrete identifier (marker) or generalise it
    // to the durable rule ("pnpm check before merge"); accept either so a
    // reasonable generalisation does not look like a failed recall.
    const matches = (marker.length > 0 && section.includes(marker)) ||
      (buildRule.length > 0 && section.toLocaleLowerCase().includes(buildRule.toLocaleLowerCase()));
    const report = {
      boundary: prompt.includes('<tdai_recalled_memory trust="untrusted" purpose="context-only">'),
      skillSection,
      promptBytes: Buffer.byteLength(prompt, "utf8"),
      matches,
    };
    report.ok = report.boundary && report.skillSection && report.matches;
    await writeFile(process.env.TDAI_E2E_REPORT, JSON.stringify(report), "utf8");
    await new Promise(() => {});
  });
}
`;
}

async function runPiSkillRecallCheck({ teamId, agentId, userId, key, keyFile, marker, buildRule, query }) {
  const temporary = await mkdtemp(join(tmpdir(), "tdai-pi-skill-e2e-"));
  const observerPath = join(temporary, "observe-skill.mjs");
  const reportPath = join(temporary, "report.json");
  const agentDir = join(temporary, "agent");
  await writeFile(observerPath, observerSource(), "utf8");

  // Enable the adapter's fifth recall layer via a global config file; the
  // identity fields still come from the environment so no secret is written.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "tdai-memory.json"), JSON.stringify({ skills: { enabled: true } }), "utf8");

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
    TDAI_E2E_BUILD_RULE: buildRule,
    TDAI_E2E_REPORT: reportPath,
    PI_CODING_AGENT_DIR: agentDir,
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
        reject(new Error(`Pi skill recall check timed out after ${Math.round(PI_TIMEOUT_MS / 1000)}s`));
      }, PI_TIMEOUT_MS);
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        clearInterval(poll);
        if (!report) reject(new Error(`Pi exited before producing a skill recall report (exit=${code})`));
        else resolvePromise({ code, stderr, report });
      });
    });
    const report = result.report;
    if (!report.ok) {
      const safeStderr = result.stderr.replaceAll(/sk-(?:mem-)?[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 500);
      throw new Error(`Pi skill recall assertion failed (exit=${result.code}, report=${JSON.stringify(report)}, stderr=${safeStderr})`);
    }
    console.log(`PASS  Pi before_agent_start injected the Skill layer (${report.promptBytes} system-prompt bytes)`);
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
  // The extracted skill's description reliably contains the term "heap" (the
  // recalled Skill layer renders name + description + snippet).
  const buildRule = "heap";
  const query = "How do I fix an intermittent out-of-memory error during a Node build?";
  const metadata = new MetadataClient({ endpoint, apiKey: userKey, serviceId: SERVICE_ID, userKey });
  const verified = await metadata.verifyAuth(userKey);
  if (!verified?.valid || !verified.user?.user_id) throw new Error("user-key verification failed");
  const userId = verified.user.user_id;
  console.log(`PASS  authentication ${mask(userId)} @ ${endpoint}`);

  const team = await metadata.createTeam({ name: `pi-skill-e2e-${stamp}`, owner_user_id: userId });
  const agent = await metadata.createAgent({
    team_id: team.team_id,
    owner_user_id: userId,
    name: `pi-skill-e2e-${stamp}`,
  });
  console.log(`PASS  isolated scope ${mask(team.team_id)} / ${mask(agent.agent_id)}`);

  const skill = new SkillClient({
    endpoint,
    apiKey: userKey,
    serviceId: SERVICE_ID,
    teamId: team.team_id,
    agentId: agent.agent_id,
    userId,
  });

  try {
    const sessionId = `pi-skill-e2e-${stamp}`;
    // A reusable debugging technique, not a project fact: "intermittent Node CI
    // build OOM -> bound the heap with NODE_OPTIONS". The review agent's gate
    // (recurring trigger + bounded task class + executable workflow, >=72 pts)
    // is designed to accept exactly this shape. The tool_result is a verbose
    // build log ending in a heap-exhaustion crash — naturally large, so this
    // single append crosses the server's 40 KB archive threshold on its own and
    // triggers extraction (the published SDK has no conversation/force-archive).
    const oomBuildLog = [
      "vite v5.4.0 building for production...",
      "transforming modules...",
      ...Array.from({ length: 750 }, (_, index) => `transforming module ./src/components/Component${String(index).padStart(3, "0")}.vue ... (${index + 1}/750)`),
      "computing gzip size...",
      "[vite:build] 90 modules transformed.",
      "",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      " 1: 0xa1c7e0 node::FatalError(v8::Isolate*, char const*, v8::OOMDetails const&)",
      " 2: 0x8b1a30 v8::internal::V8::FatalProcessOutOfMemory(v8::Isolate*, char const*, bool)",
      " 3: 0x9f4b20 v8::internal::Heap::AllocateRawWithRetryOrFailSlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment)",
      " 4: 0xa2c590 v8::internal::Factory::AllocateRaw(int, v8::internal::AllocationType, v8::internal::AllocationAlignment)",
    ].join("\n");
    const messages = [
      { role: "user", content: "My CI build keeps failing intermittently with an out-of-memory error at the vite build step. How do I fix it reliably?" },
      { role: "assistant", content: "Intermittent OOM during a bundler build usually means the build tool is running without a bounded heap. Let me capture the failing output first to confirm." },
      { role: "tool_call", content: JSON.stringify({ command: "npm run build 2>&1 | tail -c 60000" }), tool_call_id: "call-capture", tool_name: "bash" },
      { role: "tool_result", content: oomBuildLog, tool_call_id: "call-capture", tool_name: "bash" },
      { role: "tool_call", content: JSON.stringify({ command: "node -e \"console.log(process.env.NODE_OPTIONS || 'unset')\"" }), tool_call_id: "call-env", tool_name: "bash" },
      { role: "tool_result", content: "unset", tool_call_id: "call-env", tool_name: "bash" },
      { role: "assistant", content: "Confirmed: NODE_OPTIONS is unset, so vite inherits the default Node heap and can exhaust it on large builds. The reliable fix is to bound the heap in the build script so every future run is stable. Let me patch it." },
      { role: "tool_call", content: JSON.stringify({ path: "package.json", old_string: "\"build\": \"vite build\"", new_string: "\"build\": \"NODE_OPTIONS=--max-old-space-size=4096 vite build\"" }), tool_call_id: "call-fix", tool_name: "edit" },
      { role: "tool_result", content: "patched package.json build script", tool_call_id: "call-fix", tool_name: "edit" },
      { role: "assistant", content: "Fixed and re-ran the build successfully. Reusable triage for an intermittent CI OOM at the build step: (1) confirm NODE_OPTIONS is unset and the build tool has no --max-old-space-size; (2) set NODE_OPTIONS to a bounded heap (e.g. --max-old-space-size=4096) in the build script, before the build tool; (3) persist it so the fix survives restarts; (4) re-run the build to verify it no longer OOMs. Apply this pattern to any Node CI pipeline that intermittently hits the heap limit during bundling." },
    ];
    const added = await skill.conversationAdd({
      session_id: sessionId,
      user_id: userId,
      team_id: team.team_id,
      agent_id: agent.agent_id,
      messages,
    });
    if (added.status !== "archived") {
      throw new Error(`conversation/add returned ${added.status}, expected "archived" (bytes threshold)`);
    }
    console.log(`PASS  conversation/add tripped the archive threshold (task=${mask(added.archived?.task_id ?? "")})`);

    const createdSkill = await waitFor("skill created after async extraction", SKILL_EXTRACT_TIMEOUT_MS, async () => {
      const result = await skill.list();
      return result.items.find((item) => {
        const haystack = `${item.name}\n${item.description ?? ""}`;
        return /oom|heap|node.*build|build.*node|memory|max-old-space/i.test(haystack);
      });
    });
    console.log(`PASS  extracted skill created: "${createdSkill.name}" (v${createdSkill.version}, owner_agent=${mask(createdSkill.owner_agent_id ?? "")})`);

    await waitFor("skill searchable after async extraction", 60_000, async () => {
      const result = await skill.search({ query, top_k: 5, mode: "bm25", scope: "team" });
      return result.items.some((item) => {
        const haystack = `${item.name}\n${item.description ?? ""}`;
        // Search surfaces name + description + snippet; the technique keyword
        // ("max-old-space-size") lives in the SKILL.md body and may not appear
        // in any of them. Assert the skill is present by its class-level name
        // and a description-level term instead.
        return /oom|triage|heap/.test(haystack.toLocaleLowerCase());
      });
    });

    await runPiSkillRecallCheck({
      teamId: team.team_id,
      agentId: agent.agent_id,
      userId,
      key: userKey,
      keyFile,
      marker,
      buildRule,
      query,
    });

    // Phase: sync the extracted skill into Pi's native skills directory using
    // the adapter's real install path, and assert Pi discovers it.
    const syncAgentDir = await mkdtemp(join(tmpdir(), "tdai-pi-skill-sync-"));
    try {
      const synced = await installSyncedSkill({
        skill,
        agentDir: syncAgentDir,
        skillId: createdSkill.skill_id,
        source: { endpoint, teamId: team.team_id, agentId: agent.agent_id },
      });
      if (synced.status !== "synced") {
        throw new Error(`installSyncedSkill returned ${synced.status} (${synced.error ?? ""})`);
      }
      const skillMdPath = join(syncAgentDir, "skills", synced.name, "SKILL.md");
      const markerPath = join(syncAgentDir, "skills", synced.name, "tdai-remote.json");
      if (!(await readFile(skillMdPath, "utf8")).trim()) throw new Error("synced SKILL.md is empty");
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      if (marker.skillId !== createdSkill.skill_id) throw new Error("sync marker skillId mismatch");
      const loaded = loadSkillsFromDir({ dir: join(syncAgentDir, "skills"), source: "user" });
      if (!loaded.skills.some((item) => item.name === synced.name)) {
        throw new Error(`Pi did not discover synced skill "${synced.name}"`);
      }
      console.log(`PASS  synced skill "${synced.name}" (v${synced.version}) into Pi's skills dir and Pi discovered it`);
    } finally {
      await rm(syncAgentDir, { recursive: true, force: true });
    }

    console.log("\nE2E PASS: real MemoryCore Skill extraction reached the real Pi adapter recall system prompt, and the skill syncs into Pi's native skills directory.");
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
