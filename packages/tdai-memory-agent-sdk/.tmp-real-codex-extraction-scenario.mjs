import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import {
  GatewayClient,
  withCodexMemory,
} from "./dist/index.js";

const repoRoot = "/Users/bytedance/proj/TencentDB-Agent-Memory";
const rootDir = path.join(os.homedir(), ".tdai-memory", "codex-sdk");
const dataDir = path.join(rootDir, "data");
const runId = `complex-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `tdai-codex-complex-${Date.now()}`;
const sessionKey = `manual:codex-complex:${runId}`;
const gatewayUrl = `http://127.0.0.1:${await findFreePort()}`;
const startedAt = Date.now();

const beforeFiles = snapshotMemoryFiles();
const memoryCodex = withCodexMemory(new Codex(), {
  sessionKey,
  userId: "manual-real-codex-sdk",
  strict: true,
  gatewayOptions: {
    rootDir,
    dataDir,
    configPath: path.join(rootDir, "runtime", `${runId}.yaml`),
    logDir: path.join(rootDir, "logs", runId),
    runtimeDir: path.join(rootDir, "runtime", runId),
    gatewayUrl,
    gatewayCwd: repoRoot,
    startupTimeoutMs: 60_000,
    requestTimeoutMs: 120_000,
  },
});

const prompts = [
  [
    `Scenario marker: ${marker}.`,
    "We are building a TypeScript-first Agent SDK adapter for TencentDB Agent Memory.",
    "Durable user preference: keep SDK runtime data under ~/.tdai-memory/<agent sdk name>.",
    "Durable user preference: wrapper APIs should preserve the raw SDK streaming event shape.",
    "Project constraint: real-model tests should treat L0 conversation capture as the stable success signal because L1/L2/L3 extraction is asynchronous.",
    "Give a concise implementation note for this scenario.",
  ].join(" "),
  [
    `Scenario marker: ${marker}.`,
    "Architecture decision: withCodexMemory should accept a user-created Codex client, wrap startThread/createThread/thread, and return wrapped thread objects.",
    "Architecture decision: capture should store the original user prompt, not the prompt after memory context injection.",
    "Operational constraint: GatewaySupervisor should autostart the Gateway and use a per-SDK runtime directory.",
    "Return a short acceptance checklist.",
  ].join(" "),
  [
    `Scenario marker: ${marker}.`,
    "Debug note: direct Gateway /capture calls can miss L0 when message timestamps are absent and the first checkpoint floor equals capture time.",
    "Implementation decision: SDK capture should send turn startedAt plus explicit user and assistant message timestamps.",
    "Testing preference: for this manual run, do not evaluate whether extracted memories are semantically correct; only check whether extraction files are produced.",
    "Summarize the handoff.",
  ].join(" "),
  [
    `Scenario marker: ${marker}.`,
    "Follow-up decision: Claude Code SDK uses query as an AsyncIterable and cancellation should use abortController, while this manual scenario is Codex-only.",
    "Team workflow preference: keep follow-up reports factual, list generated file paths, and avoid treating delayed L1/L2/L3 extraction as a foreground failure.",
    "Produce a concise final status update.",
  ].join(" "),
];

try {
  console.log(JSON.stringify({ event: "scenario.start", gatewayUrl, sessionKey, marker, dataDir }, null, 2));

  const thread = await memoryCodex.startThread({
    workingDirectory: repoRoot,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    modelReasoningEffort: "low",
  });

  for (let index = 0; index < prompts.length; index++) {
    const prompt = prompts[index];
    const turnStartedAt = Date.now();
    let eventCount = 0;
    let text = "";
    for await (const event of thread.runStreamed(prompt, { signal: AbortSignal.timeout(120_000) })) {
      eventCount += 1;
      text += extractEventText(event);
    }
    console.log(JSON.stringify({
      event: "turn.done",
      turn: index + 1,
      eventCount,
      textChars: text.length,
      elapsedMs: Date.now() - turnStartedAt,
    }));
  }

  await thread.endMemorySession();

  const client = new GatewayClient({ gatewayUrl, timeoutMs: 120_000 });
  await eventually(async () => {
    const search = await client.searchConversations({ query: marker, sessionKey });
    if (!search.results.includes(marker)) {
      throw new Error(`L0 search did not find marker yet; total=${search.total}`);
    }
    return search;
  }, 60_000);

  const extraction = await waitForExtractionFiles(beforeFiles, startedAt, marker, 240_000);
  console.log(JSON.stringify({ event: "scenario.result", ...extraction }, null, 2));
} finally {
  await memoryCodex.endMemorySession().catch(() => undefined);
  await memoryCodex.close().catch(() => undefined);
}

async function findFreePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("could not allocate test port");
  return address.port;
}

function extractEventText(event) {
  if (!event || typeof event !== "object") return typeof event === "string" ? event : "";
  if (event.type === "item.completed" || event.type === "item.updated" || event.type === "item.started") {
    const item = event.item;
    if (item && typeof item === "object" && item.type === "agent_message" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

async function eventually(assertion, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await delay(1000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForExtractionFiles(beforeFiles, startMs, markerText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = { hasExtraction: false, files: [], markerHits: [] };
  while (Date.now() < deadline) {
    latest = inspectExtractionFiles(beforeFiles, startMs, markerText);
    if (latest.hasExtraction) return latest;
    await delay(3000);
  }
  return latest;
}

function inspectExtractionFiles(beforeFiles, startMs, markerText) {
  const files = snapshotMemoryFiles()
    .filter((file) => {
      if (beforeFiles.has(file.path)) return false;
      if (!isExtractionPath(file.path)) return false;
      return file.mtimeMs >= startMs - 1000 || file.size > 0;
    })
    .map((file) => file.path);

  const markerHits = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, "utf-8");
      if (raw.includes(markerText)) markerHits.push(file);
    } catch {}
  }

  return {
    hasExtraction: files.length > 0,
    files,
    markerHits,
  };
}

function snapshotMemoryFiles() {
  const files = [];
  for (const dir of [
    path.join(dataDir, "records"),
    path.join(dataDir, "scene_blocks"),
    dataDir,
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walkFiles(dir)) {
      const stat = fs.statSync(file);
      files.push({ path: file, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return files;
}

function isExtractionPath(file) {
  return file.includes("/records/") ||
    file.includes("/scene_blocks/") ||
    file.endsWith("/persona.md") ||
    file.endsWith("/ persona.md");
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    if (entry.isFile()) out.push(full);
  }
  return out;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
