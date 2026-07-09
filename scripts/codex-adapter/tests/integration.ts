import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TdaiGateway } from "../../../src/gateway/server.js";
import { VectorStore } from "../../../src/core/store/sqlite.js";
import type { MemoryRecord } from "../../../src/core/record/l1-writer.js";

interface CommandResult {
  stdout: string;
  stderr: string;
}

const repoRoot = path.resolve(new URL("../../../", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1"));
const sessionKey = "codex:adapter-integration";
const sessionId = "codex-session-1";

function runAdapter(args: string[], port: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "bin/memory-tencentdb-codex.mjs",
        ...args,
        "--gateway-url",
        `http://127.0.0.1:${port}`,
        "--session-key",
        sessionKey,
        "--session-id",
        sessionId,
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`adapter timeout: ${args.join(" ")}`));
    }, 20_000);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`adapter failed (${code}): ${args.join(" ")}\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} did not include ${needle}. Output:\n${haystack}`);
  }
}

async function seedL1Memory(dataDir: string, marker: string): Promise<void> {
  const store = new VectorStore(path.join(dataDir, "vectors.db"), 0, console);
  store.init({ provider: "none", model: "none", dimensions: 0 });
  const now = new Date().toISOString();
  const record: MemoryRecord = {
    id: `codex-adapter-l1-${marker}`,
    content: `Codex adapter integration recall marker: ${marker}. Prefer concise final summaries for this workspace.`,
    type: "instruction",
    priority: 90,
    scene_name: "codex-adapter-integration",
    source_message_ids: [`seed:${marker}`],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    sessionKey,
    sessionId,
  };
  const ok = store.upsertL1(record, undefined);
  store.close();
  if (!ok) throw new Error("failed to seed L1 memory");
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "tdai-codex-full-"));
  const port = 18427;
  const configPath = path.join(dataDir, "tdai-gateway.json");
  const l0Marker = `codex-l0-${Date.now()}`;
  const l1Marker = `codex-l1-${Date.now()}`;

  writeFileSync(configPath, JSON.stringify({
    server: { port, host: "127.0.0.1" },
    data: { baseDir: dataDir },
    memory: {
      capture: { enabled: true },
      extraction: { enabled: false },
      recall: { enabled: true, strategy: "fts", maxResults: 5, scoreThreshold: 0 },
      embedding: { provider: "none", enabled: false },
      pipeline: { everyNConversations: 999999, enableWarmup: false },
      llm: { enabled: false },
    },
  }, null, 2));

  process.env.TDAI_GATEWAY_CONFIG = configPath;
  const gateway = new TdaiGateway();

  try {
    await seedL1Memory(dataDir, l1Marker);
    await gateway.start();

    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()) as { status?: string };
    if (health.status !== "ok") throw new Error(`gateway health failed: ${JSON.stringify(health)}`);
    console.log(`health ok on port ${port}`);

    const capture = await runAdapter([
      "capture",
      "--user",
      `Please remember this Codex L0 marker: ${l0Marker}`,
      "--assistant",
      `Captured Codex L0 marker ${l0Marker}`,
    ], port);
    assertIncludes(capture.stdout, "l0_recorded", "capture response");
    console.log("capture ok");

    const conversationSearch = await runAdapter([
      "conversation-search",
      "--query",
      l0Marker,
      "--limit",
      "5",
      "--json",
    ], port);
    assertIncludes(conversationSearch.stdout, l0Marker, "conversation-search response");
    console.log("conversation-search ok");

    const memorySearch = await runAdapter([
      "search",
      "--query",
      l1Marker,
      "--limit",
      "5",
      "--json",
    ], port);
    assertIncludes(memorySearch.stdout, l1Marker, "memory search response");
    console.log("memory-search ok");

    const recall = await runAdapter([
      "recall",
      "--query",
      l1Marker,
      "--json",
    ], port);
    assertIncludes(recall.stdout, l1Marker, "recall response");
    console.log("recall ok");

    console.log(JSON.stringify({
      ok: true,
      port,
      sessionKey,
      l0Marker,
      l1Marker,
      checks: ["health", "capture", "conversation-search", "memory-search", "recall"],
    }, null, 2));
  } finally {
    await gateway.stop();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.TDAI_GATEWAY_CONFIG;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
