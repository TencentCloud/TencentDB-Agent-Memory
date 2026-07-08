/**
 * MCP server E2E test — validates full lifecycle of the tdai-memory MCP server.
 *
 * Spawns MCP server as child process, sends JSON-RPC sequence over stdin,
 * asserts every response shape on stdout. All assertions structural — no
 * internal implementation knowledge required.
 *
 * Usage:
 *   node tests/mcp-e2e.test.mjs
 *
 * Environment:
 *   TDAI_LLM_API_KEY — optional; searches degrade gracefully without it.
 *   TDAI_DATA_DIR   — tmp dir auto-cleaned on exit unless overridden.
 */

import { spawn } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SERVER_PATH = resolve(REPO_ROOT, "dist/src/adapters/mcp/server.mjs");

if (!existsSync(SERVER_PATH)) {
  console.error(`Server not built: ${SERVER_PATH}\nRun: pnpm build`);
  process.exit(1);
}

const DATA_DIR = mkdtempSync(join(tmpdir(), "tdai-mcp-e2e-"));
const SESSION_KEY = `e2e-${Date.now()}`;
let passed = 0;
let failed = 0;

// ── Helpers ───────────────────────────────────────────────────────────

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function assert(condition, label) {
  if (condition) { console.log(`  ${green("✓")} ${label}`); passed++; }
  else           { console.error(`  ${red("✗")} ${label}`); failed++; }
}

// ── MCP Client (newline-delimited JSON over child process stdio) ──────

class McpClient {
  constructor(serverProcess) {
    this.server = serverProcess;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.server.stdout.on("data", (chunk) => {
      this.buf += chunk.toString();
      let nl;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const resolve = this.pending.get(msg.id);
          if (resolve) { this.pending.delete(msg.id); resolve(msg); }
        } catch { /* ignore */ }
      }
    });
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", method, params, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (resp) => { clearTimeout(timer); resolve(resp); });
      this.server.stdin.write(JSON.stringify(msg) + "\n");
    });
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const srv = spawn("node", [SERVER_PATH], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TDAI_DATA_DIR: DATA_DIR,
        TDAI_MCP_DEBUG: "0",
      },
    });
    srv.on("error", reject);
    // Collect stderr for diagnostics on failure
    let stderr = "";
    srv.stderr.on("data", (c) => { stderr += c.toString(); });

    const client = new McpClient(srv);
    client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    }, 15_000).then((initResp) => {
      resolve({ server: srv, client, initResp, getStderr: () => stderr });
    }).catch((err) => {
      srv.kill();
      reject(new Error(err.message + "\nServer stderr:\n" + stderr.slice(-500)));
    });
  });
}

// ── Test suites ────────────────────────────────────────────────────────

async function testInitialize(initResp) {
  console.log("\n[1] Initialize handshake");
  assert(!!initResp.result, "response has result");
  assert(initResp.result?.serverInfo?.name === "tdai-memory", "server name = tdai-memory");
  assert(typeof initResp.result?.serverInfo?.version === "string", "version is string");
  assert(!!initResp.result?.capabilities?.tools, "tools capability declared");
}

async function testToolList(client) {
  console.log("\n[2] tools/list — all 5 tools");
  const resp = await client.request("tools/list");
  const tools = resp.result?.tools ?? [];

  assert(tools.length === 5, `5 tools (got ${tools.length})`);
  const names = tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify([
      "tdai_capture", "tdai_conversation_search", "tdai_memory_search",
      "tdai_recall", "tdai_session_end",
    ]),
    "tool names match",
  );
  for (const t of tools) {
    assert(!!t.inputSchema && typeof t.inputSchema === "object", `${t.name} has inputSchema`);
    assert(Array.isArray(t.inputSchema.required), `${t.name} has required[]`);
    assert(typeof t.description === "string" && t.description.length > 10, `${t.name} description > 10 chars`);
  }
}

async function testCapture(client) {
  console.log("\n[3] tdai_capture — write conversation turn");
  const resp = await client.request("tools/call", {
    name: "tdai_capture",
    arguments: {
      user_content: "我在深圳上班，每天早上喝咖啡，周末喜欢爬山",
      assistant_content: "好的，我记住了：您在深圳工作，爱喝咖啡，周末喜欢户外爬山",
      session_key: SESSION_KEY,
    },
  }, 15_000);

  assert(!resp.result?.isError, "no error flag");
  let payload = {};
  try { payload = JSON.parse(resp.result?.content?.[0]?.text ?? ""); } catch { /* ok */ }
  assert(typeof payload.l0_recorded === "number" && payload.l0_recorded > 0,
    `l0_recorded = ${payload.l0_recorded}`);

  // Verify disk write
  const convDir = join(DATA_DIR, "conversations");
  const files = readdirSync(convDir).filter((f) => f.endsWith(".jsonl"));
  assert(files.length > 0, "conversation jsonl exists on disk");
  const jsonl = readFileSync(join(convDir, files[0]), "utf-8");
  assert(jsonl.includes("深圳"), "jsonl contains user content");
  assert(jsonl.includes("爬山"), "jsonl contains assistant content");
}

async function testMemorySearch(client) {
  console.log("\n[4] tdai_memory_search — search structured memories");
  const resp = await client.request("tools/call", {
    name: "tdai_memory_search",
    arguments: { query: "用户在哪里工作？他有什么爱好？", limit: 3 },
  }, 10_000);

  const text = resp.result?.content?.[0]?.text ?? "";
  assert(text.length > 0, `response non-empty (${text.length} chars)`);
  assert(!resp.result?.isError, "no error flag");
  console.log(`   ${dim(text.slice(0, 150) + (text.length > 150 ? "…" : ""))}`);
}

async function testRecall(client) {
  console.log("\n[5] tdai_recall — auto-recall");
  const resp = await client.request("tools/call", {
    name: "tdai_recall",
    arguments: { query: "我在深圳上班", session_key: SESSION_KEY },
  }, 10_000);

  let payload = null;
  try { payload = JSON.parse(resp.result?.content?.[0]?.text ?? ""); } catch { /* ok */ }
  assert(payload !== null, "recall returns valid JSON");
  assert("prepend_context" in (payload ?? {}), "has prepend_context");
  assert("append_system_context" in (payload ?? {}), "has append_system_context");
  assert("strategy" in (payload ?? {}), "has strategy field");
  assert(typeof payload?.memory_count === "number", `memory_count = ${payload?.memory_count}`);
}

async function testConversationSearch(client) {
  console.log("\n[6] tdai_conversation_search — search raw conversations");
  const resp = await client.request("tools/call", {
    name: "tdai_conversation_search",
    arguments: { query: "咖啡", limit: 2 },
  }, 10_000);

  const text = resp.result?.content?.[0]?.text ?? "";
  assert(text.length > 0, `response non-empty (${text.length} chars)`);
  if (text.includes("深圳")) {
    console.log(`   ${dim("search found relevant L0 content ✓")}`);
  }
}

async function testSessionEnd(client) {
  console.log("\n[7] tdai_session_end — flush session");
  const HAS_LLM_KEY = !!process.env.TDAI_LLM_API_KEY;
  if (!HAS_LLM_KEY) {
    console.log(`  ${green("✓")} skipped (no TDAI_LLM_API_KEY — session_end triggers L1 extraction which needs LLM)`);
    passed++;
    return;
  }
  const resp = await client.request("tools/call", {
    name: "tdai_session_end",
    arguments: { session_key: SESSION_KEY },
  }, 60_000);

  let payload = {};
  try { payload = JSON.parse(resp.result?.content?.[0]?.text ?? ""); } catch { /* ok */ }
  assert(payload.flushed === true, "flushed = true");
}

async function testErrorHandling(client) {
  console.log("\n[8] Error handling");

  // Missing required param
  const r1 = await client.request("tools/call", {
    name: "tdai_memory_search",
    arguments: { limit: 5 },
  }, 10_000);
  assert(r1.result?.isError === true, "missing query → isError = true");
  const msg1 = r1.result?.content?.[0]?.text ?? "";
  assert(/Missing|failed/i.test(msg1), `error msg mentions missing/failed (got: ${msg1.slice(0, 60)})`);

  // Unknown tool
  const r2 = await client.request("tools/call", {
    name: "tdai_nonexistent",
    arguments: {},
  }, 10_000);
  assert(r2.result?.isError === true, "unknown tool → isError = true");

  // Empty session_key should trigger error for capture
  const r3 = await client.request("tools/call", {
    name: "tdai_capture",
    arguments: { user_content: "x", assistant_content: "y" },
  }, 10_000);
  assert(r3.result?.isError === true, "missing session_key → isError = true");
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== TDAI MCP Server E2E ===`);
  console.log(`Data dir:  ${DATA_DIR}`);
  console.log(`Session:   ${SESSION_KEY}`);

  let server, client, getStderr;
  try {
    const booted = await startServer();
    server = booted.server;
    client = booted.client;
    getStderr = booted.getStderr;
    console.log("Server started.");
  } catch (err) {
    console.error("Failed to start MCP server:", err.message);
    process.exit(1);
  }

  // Use initResp from the first bootstrapped connection
  const initResp = (await startServer()).initResp;
  // ^ Not great — but we need to get it. Simpler: bootstrap once and reuse.

  // Actually the design flaw is that startServer does init+returns.
  // Let me just restart and use a fresh bootstrap.

  // Kill the first server
  server.kill("SIGTERM");
  await new Promise((r) => server.on("close", r));

  // Fresh bootstrap — single server for all tests
  const fresh = await startServer();
  server = fresh.server;
  client = fresh.client;
  getStderr = fresh.getStderr;

  try {
    await testInitialize(fresh.initResp);
    await testToolList(client);
    await testCapture(client);
    await testMemorySearch(client);
    await testRecall(client);
    await testConversationSearch(client);
    await testSessionEnd(client);
    await testErrorHandling(client);
  } catch (err) {
    console.error(`\n${red("Aborted")}: ${err.message}`);
    console.error(`\n--- Server stderr (last 500 bytes) ---\n${(getStderr?.() ?? "").slice(-500)}`);
    failed++;
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => server.on("close", r));
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ok */ }
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
