/**
 * Multi-user gateway E2E — real gateway process, real HTTP.
 *
 * Unlike `multi-user.test.ts` (in-process `TdaiGateway` instances), this suite
 * boots the actual server (`node --import tsx src/gateway/server.ts`) as a
 * subprocess and drives it over HTTP, exactly like the Hermes provider does:
 *
 *   - user "a" captures 3 rounds, user "b" captures 2 rounds
 *   - `users/a/vectors.db` and `users/b/vectors.db` exist on disk
 *   - a/b `/search/conversations` results are mutually invisible
 *   - the root (main) store holds no teacher data
 *   - `user_id=wendy.li` (invalid uid) fails closed to the main store
 *   - `/seed` with a regular user id → 403, without → 200
 *   - with `TDAI_MULTI_USER` off, the same requests all land in the main store
 *   - with an in-test mock OpenAI-compatible LLM, the real L1 extraction
 *     pipeline produces per-user `l1_records` rows + checkpoints that stay
 *     isolated across users (plan §7.2)
 *   - with `TDAI_GATEWAY_API_KEY` set, missing/wrong Bearer → 401, correct
 *     Bearer → 200, `GET /health` stays reachable without a token
 *
 * Environment red lines (this machine runs a production gateway):
 *   - the test gateways bind 127.0.0.1:1842x, never 8420
 *     (`startGateway` hard-refuses port 8420)
 *   - `TDAI_DATA_DIR` always points at a `fs.mkdtemp` directory under
 *     `os.tmpdir()` — never at `~/.memory-tencentdb` — and is removed after
 *     the run (`startGateway` refuses any data dir outside the tmpdir)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, onTestFailed } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "src", "gateway", "server.ts");

/** Test-only ports — deliberately far from the production gateway on 8420. */
const PORT_MULTI_USER = 18420;
const PORT_LEGACY = 18421;
const PORT_AUTH = 18422;
const PORT_L1_ISOLATION = 18423;
/** In-test mock OpenAI-compatible LLM server (used by the L1 isolation test). */
const PORT_MOCK_LLM = 18430;

const GATEWAY_STARTUP_TIMEOUT_MS = 45_000;
const CAPTURE_RECORDED_TIMEOUT_MS = 15_000;
/** Bounded wait for the background L1 extraction to land in vectors.db. */
const L1_EXTRACTION_TIMEOUT_MS = 30_000;
/**
 * The capture path defers the L0 search-index write to a background task
 * ("metadata-only, embed=background") — a capture's HTTP response returns
 * before `/search/conversations` can see the round. Search visibility is
 * therefore eventual; tests poll for it within this window.
 */
const SEARCH_VISIBLE_TIMEOUT_MS = 10_000;

interface CaptureResponseJson {
  l0_recorded: number;
  scheduler_notified: boolean;
}

interface ConversationSearchResponseJson {
  results: string;
  total: number;
}

interface MemorySearchResponseJson {
  results: string;
  total: number;
  strategy: string;
}

interface SeedResponseJson {
  sessions_processed: number;
  rounds_processed: number;
  messages_processed: number;
  l0_recorded: number;
  duration_ms: number;
  output_dir: string;
}

interface GatewayHandle {
  baseUrl: string;
  port: number;
  dataDir: string;
  stop: () => Promise<void>;
  dumpLogs: () => string;
}

const spawnedGateways: GatewayHandle[] = [];
const tmpDirs: string[] = [];

afterAll(async () => {
  for (const gw of spawnedGateways) {
    await gw.stop().catch(() => {});
  }
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — leftover temp dirs must not fail the suite.
    }
  }
});

// ============================
// Helpers
// ============================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gw-e2e-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Boot the real gateway server as a subprocess.
 *
 * The environment passed to the child is scrubbed of every `TDAI_*` /
 * `MEMORY_TENCENTDB_*` variable first, so a developer shell (or this
 * machine's production gateway setup) cannot leak config into the test, then
 * the test's own values are injected. `TDAI_GATEWAY_CONFIG` points at an
 * empty JSON file so no machine-level `tdai-gateway.yaml` is picked up.
 */
async function startGateway(opts: {
  port: number;
  multiUser?: boolean;
  ownerUserIds?: string[];
  /** Enable `TDAI_GATEWAY_API_KEY` Bearer auth on the child gateway. */
  apiKey?: string;
  /** Extra env vars injected into the child (e.g. the mock LLM endpoint). */
  extraEnv?: Record<string, string>;
  /**
   * Content of the child's `tdai-gateway.json` config file (default `{}`).
   * Used to pin pipeline knobs (e.g. warm-up) for deterministic scenarios.
   */
  gatewayConfigFile?: Record<string, unknown>;
}): Promise<GatewayHandle> {
  const { port, multiUser = false, ownerUserIds = [], apiKey, extraEnv = {}, gatewayConfigFile = {} } = opts;

  // Red lines: never the production port, never outside the tmpdir.
  if (port === 8420) throw new Error("Refusing to start a test gateway on the production port 8420");
  const dataDir = makeTmpDir();
  if (!dataDir.startsWith(os.tmpdir())) throw new Error(`Refusing data dir outside tmpdir: ${dataDir}`);

  // Config file → env-driven plus the caller's overrides, no host leakage.
  fs.writeFileSync(path.join(dataDir, "gateway-config.json"), JSON.stringify(gatewayConfigFile));

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("TDAI_") || key.startsWith("MEMORY_TENCENTDB_") || key === "NODE_OPTIONS") continue;
    env[key] = value;
  }
  env.TDAI_GATEWAY_HOST = "127.0.0.1";
  env.TDAI_GATEWAY_PORT = String(port);
  env.TDAI_DATA_DIR = dataDir;
  env.TDAI_GATEWAY_CONFIG = path.join(dataDir, "gateway-config.json");
  if (multiUser) {
    env.TDAI_MULTI_USER = "true";
    if (ownerUserIds.length > 0) env.TDAI_MULTI_USER_OWNERS = ownerUserIds.join(",");
  }
  if (apiKey) env.TDAI_GATEWAY_API_KEY = apiKey;
  Object.assign(env, extraEnv);

  const child = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const collect = (chunk: Buffer, sink: string[]) => {
    sink.push(chunk.toString("utf-8"));
    if (sink.length > 500) sink.shift(); // bounded — logs are diagnostics only
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, stdoutChunks));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, stderrChunks));

  const handle: GatewayHandle = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    dataDir,
    dumpLogs: () =>
      [`--- stdout ---`, ...stdoutChunks.slice(-40), `--- stderr ---`, ...stderrChunks.slice(-40)].join("\n"),
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        killTimer.unref?.();
        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
  spawnedGateways.push(handle);

  // Wait for GET /health to answer (tsx compile + core init take a moment).
  const deadline = Date.now() + GATEWAY_STARTUP_TIMEOUT_MS;
  let lastError: unknown = new Error("gateway never became healthy");
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited early (code=${child.exitCode})\n${handle.dumpLogs()}`);
    }
    try {
      const res = await fetch(`${handle.baseUrl}/health`);
      if (res.ok) return handle;
      lastError = new Error(`/health returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  throw new Error(`gateway on :${port} not healthy after ${GATEWAY_STARTUP_TIMEOUT_MS}ms: ${lastError}\n${handle.dumpLogs()}`);
}

async function postJson<T>(
  base: string,
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

// ============================
// In-test mock OpenAI-compatible LLM
// ============================

/**
 * Minimal extraction output the mock always returns. Crafted against the real
 * parser (`parseExtractionResult` in src/core/record/l1-extractor.ts): a JSON
 * array of scene segments, each with `scene_name` and `memories[]` entries
 * carrying a string `content` and a valid memory `type`
 * (persona | episodic | instruction — anything else is skipped).
 *
 * The body is identical for every request (extraction, dedup judgment, scene
 * extraction — the mock does not model the LLM), so per-user distinction in
 * the assertions comes from real pipeline data: session keys and L0 tokens,
 * never from the mock.
 */
const MOCK_MEMORY_CONTENT = "the violet morse sentinel radio checks in at dawn";
const MOCK_EXTRACTION_ARRAY = JSON.stringify([
  {
    scene_name: "e2e-mock-scene",
    message_ids: [],
    memories: [
      {
        content: MOCK_MEMORY_CONTENT,
        type: "episodic",
        priority: 50,
        source_message_ids: [],
        metadata: {},
      },
    ],
  },
]);

interface MockLlmHandle {
  baseUrl: string;
  /** Number of chat-completion requests the mock answered. */
  requestCount: () => number;
  close: () => Promise<void>;
}

/**
 * Start a tolerant OpenAI-compatible mock: ANY request to ANY path returns
 * `200` with the same canned `chat.completion` body whose message content is
 * {@link MOCK_EXTRACTION_ARRAY}. Never rejects a request, so whichever
 * pipeline stage calls it (L1 extraction today, L2/L3 at shutdown flush)
 * gets a parseable response.
 *
 * Reliability details that matter: the request body is fully drained before
 * responding (Node emits `request` on end-of-headers — replying early can
 * reset the socket mid-upload, and a single failed LLM call soft-fails the
 * pipeline run), and every response closes the connection (no keep-alive, so
 * the client never reuses a socket the mock is tearing down).
 */
async function startMockLlmServer(): Promise<MockLlmHandle> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.resume(); // drain the request body so `end` fires and upload never stalls
    req.on("error", () => res.destroy());
    req.on("end", () => {
      requests += 1;
      const body = JSON.stringify({
        id: "chatcmpl-e2e-mock",
        object: "chat.completion",
        created: 1,
        model: "mock",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: MOCK_EXTRACTION_ARRAY },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Connection: "close",
      });
      res.end(body);
    });
  });
  server.keepAliveTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT_MOCK_LLM, "127.0.0.1", () => resolve());
  });

  return {
    baseUrl: `http://127.0.0.1:${PORT_MOCK_LLM}/v1`,
    requestCount: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function searchConversations(
  base: string,
  query: string,
  userId?: string,
): Promise<ConversationSearchResponseJson> {
  const { status, json } = await postJson<ConversationSearchResponseJson>(base, "/search/conversations", {
    query,
    limit: 20,
    ...(userId !== undefined ? { user_id: userId } : {}),
  });
  expect(status, `/search/conversations status`).toBe(200);
  return json;
}

async function searchMemories(base: string, query: string, userId?: string): Promise<MemorySearchResponseJson> {
  const { status, json } = await postJson<MemorySearchResponseJson>(base, "/search/memories", {
    query,
    limit: 20,
    ...(userId !== undefined ? { user_id: userId } : {}),
  });
  expect(status, `/search/memories status`).toBe(200);
  return json;
}

/**
 * Poll a conversation search until a captured round becomes visible (and the
 * results carry `mustContain`). The capture response can beat the background
 * index write — see {@link SEARCH_VISIBLE_TIMEOUT_MS}.
 */
async function searchConversationsUntilVisible(
  base: string,
  query: string,
  userId: string | undefined,
  mustContain: string,
): Promise<ConversationSearchResponseJson> {
  const deadline = Date.now() + SEARCH_VISIBLE_TIMEOUT_MS;
  let last: ConversationSearchResponseJson | undefined;
  while (Date.now() < deadline) {
    last = await searchConversations(base, query, userId);
    if (last.total > 0 && last.results.includes(mustContain)) return last;
    await sleep(100);
  }
  throw new Error(
    `search/conversations for "${query}" never showed "${mustContain}" within ` +
    `${SEARCH_VISIBLE_TIMEOUT_MS}ms (last: ${JSON.stringify(last)})`,
  );
}

/**
 * Poll a memory search until the extracted content becomes visible — same
 * eventual-visibility contract as {@link searchConversationsUntilVisible}.
 */
async function searchMemoriesUntilVisible(
  base: string,
  query: string,
  userId: string | undefined,
  mustContain: string,
): Promise<MemorySearchResponseJson> {
  const deadline = Date.now() + SEARCH_VISIBLE_TIMEOUT_MS;
  let last: MemorySearchResponseJson | undefined;
  while (Date.now() < deadline) {
    last = await searchMemories(base, query, userId);
    if (last.total > 0 && last.results.includes(mustContain)) return last;
    await sleep(100);
  }
  throw new Error(
    `search/memories for "${query}" never showed the expected content within ` +
    `${SEARCH_VISIBLE_TIMEOUT_MS}ms (last: ${JSON.stringify(last)})`,
  );
}

/**
 * Register a per-test failure handler that dumps the child gateway's logs.
 * Without them an e2e assertion failure is undiagnosable (the interesting
 * evidence lives in the subprocess's stdout/stderr).
 */
function dumpLogsOnFailure(gw: GatewayHandle): void {
  onTestFailed(() => {
    console.error(`\n${gw.dumpLogs()}\n`);
  });
}

/**
 * POST /capture, retrying until `l0_recorded > 0`.
 *
 * The first capture of a session applies the cold-start guard
 * (`pluginStartTimestamp` = Date.now() as the cursor floor) while message
 * timestamps are assigned at extraction time inside the checkpoint lock —
 * on the rare millisecond where both land on the same value, the round is
 * legitimately filtered out (l0_recorded=0, cursor unchanged). Retrying the
 * same request is therefore safe and matches how a client would observe the
 * `{"l0_recorded":...}` contract.
 */
async function captureRound(
  base: string,
  body: { user_content: string; assistant_content: string; session_key: string; user_id?: string },
): Promise<CaptureResponseJson> {
  const deadline = Date.now() + CAPTURE_RECORDED_TIMEOUT_MS;
  let lastRecorded = 0;
  while (Date.now() < deadline) {
    const { status, json } = await postJson<CaptureResponseJson>(base, "/capture", body);
    expect(status, "/capture status").toBe(200);
    lastRecorded = json.l0_recorded;
    if (lastRecorded > 0) return json;
    await sleep(50);
  }
  throw new Error(`capture for session=${body.session_key} never recorded L0 (last l0_recorded=${lastRecorded})`);
}

function readAllJsonl(dir: string): string {
  if (!fs.existsSync(dir)) return "";
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf-8"))
    .join("\n");
}

/** Poll `predicate` until truthy or `timeoutMs` elapses (200ms cadence). */
async function pollUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw new Error(`${what} not observed within ${timeoutMs}ms`);
}

/**
 * Count rows of a SQLite table (e.g. `l0_conversations`, `l1_records`),
 * optionally restricted to `sessionKey IN (...)`. Reads the gateway's SQLite
 * file directly. `node:sqlite` is unflagged from node 23.4 but needs
 * `--experimental-sqlite` on the 22.x line — try plain first, then flagged.
 */
async function countRows(dbPath: string, table: string, sessionKeys?: string[]): Promise<number> {
  const script = [
    'const { DatabaseSync } = require("node:sqlite");',
    'const db = new DatabaseSync(process.argv[1], { readOnly: true });',
    "const table = process.argv[2];",
    "const keys = process.argv.slice(3);",
    "let row;",
    "if (keys.length === 0) {",
    "  row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();",
    "} else {",
    '  const placeholders = keys.map(() => "?").join(",");',
    "  row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_key IN (${placeholders})`).get(...keys);",
    "}",
    "console.log(String(row.n));",
  ].join("\n");
  for (const flags of [[], ["--experimental-sqlite"]]) {
    const result = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [...flags, "-e", script, dbPath, table, ...(sessionKeys ?? [])], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
      child.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
    });
    if (result.status === 0) {
      const n = Number.parseInt(result.stdout.trim(), 10);
      expect(Number.isFinite(n), `sqlite count parsed from "${result.stdout.trim()}"`).toBe(true);
      return n;
    }
    // The table is created together with vectors.db at store init — a missing
    // table simply means "store not there yet", which counts as 0 for polling.
    if (/no such table/i.test(result.stderr)) return 0;
    if (!/node:sqlite|--experimental-sqlite/i.test(result.stderr)) {
      throw new Error(`sqlite count failed: ${result.stderr.trim()}`);
    }
  }
  throw new Error("could not query node:sqlite (tried plain and --experimental-sqlite)");
}

// ============================
// The e2e scenarios
// ============================

describe("gateway multi-user e2e (real subprocess + HTTP)", () => {
  it("routes per-user captures to isolated stores, fails closed on invalid uids, and guards /seed", async () => {
    const gw = await startGateway({ port: PORT_MULTI_USER, multiUser: true, ownerUserIds: ["ops-admin"] });
    dumpLogsOnFailure(gw);

    try {
      // ── user "a" captures 3 rounds, user "b" captures 2 rounds ──
      for (let round = 1; round <= 3; round++) {
        const res = await captureRound(gw.baseUrl, {
          user_id: "a",
          session_key: "sess-e2e-a-1",
          user_content: `round ${round} for user a: the depot password is magpie`,
          assistant_content: `ack round ${round} for user a`,
        });
        expect(res.l0_recorded).toBeGreaterThan(0);
      }
      for (let round = 1; round <= 2; round++) {
        const res = await captureRound(gw.baseUrl, {
          user_id: "b",
          session_key: "sess-e2e-b-1",
          user_content: `round ${round} for user b: the crane schedule is faxed at dawn`,
          assistant_content: `ack round ${round} for user b`,
        });
        expect(res.l0_recorded).toBeGreaterThan(0);
      }

      // ── owner uid and invalid uid (fail-closed) captures land in the main store ──
      const opsRes = await captureRound(gw.baseUrl, {
        user_id: "ops-admin", // listed in TDAI_MULTI_USER_OWNERS → main store
        session_key: "sess-e2e-ops-1",
        user_content: "ops round 1: the granite maintenance window is friday",
        assistant_content: "ack ops round 1",
      });
      expect(opsRes.l0_recorded).toBeGreaterThan(0);

      const wliRes = await captureRound(gw.baseUrl, {
        user_id: "wendy.li", // dot is outside ^[a-z0-9_-]{1,64}$ → main store, no stripping
        session_key: "sess-e2e-wli-1",
        user_content: "legacy round 1: the willow gate code is nine",
        assistant_content: "ack legacy round 1",
      });
      expect(wliRes.l0_recorded).toBeGreaterThan(0);

      // ── on-disk layout: users/a + users/b exist; owner/invalid never got one ──
      expect(fs.existsSync(path.join(gw.dataDir, "users", "a", "vectors.db"))).toBe(true);
      expect(fs.existsSync(path.join(gw.dataDir, "users", "b", "vectors.db"))).toBe(true);
      expect(fs.existsSync(path.join(gw.dataDir, "users", "ops-admin"))).toBe(false);
      expect(fs.existsSync(path.join(gw.dataDir, "users", "wendy.li"))).toBe(false);

      // ── /search/conversations isolation: a and b are mutually invisible ──
      const aSeesOwn = await searchConversationsUntilVisible(gw.baseUrl, "magpie", "a", "sess-e2e-a-1");
      expect(aSeesOwn.total).toBeGreaterThan(0);
      expect(aSeesOwn.results).toContain("magpie");

      const aSeesB = await searchConversations(gw.baseUrl, "crane", "a");
      expect(aSeesB.total).toBe(0);
      expect(aSeesB.results).not.toContain("crane");

      const bSeesOwn = await searchConversationsUntilVisible(gw.baseUrl, "crane", "b", "sess-e2e-b-1");
      expect(bSeesOwn.total).toBeGreaterThan(0);
      expect(bSeesOwn.results).toContain("crane");

      const bSeesA = await searchConversations(gw.baseUrl, "magpie", "b");
      expect(bSeesA.total).toBe(0);
      expect(bSeesA.results).not.toContain("magpie");

      // ── the main store holds no teacher data ──
      const mainSeesA = await searchConversations(gw.baseUrl, "magpie");
      expect(mainSeesA.total).toBe(0);
      const mainSeesB = await searchConversations(gw.baseUrl, "crane");
      expect(mainSeesB.total).toBe(0);

      const rootJsonl = readAllJsonl(path.join(gw.dataDir, "conversations"));
      expect(rootJsonl).not.toContain("sess-e2e-a-1");
      expect(rootJsonl).not.toContain("sess-e2e-b-1");
      // …but it does carry the fail-closed (owner + invalid uid) captures.
      expect(rootJsonl).toContain("sess-e2e-ops-1");
      expect(rootJsonl).toContain("sess-e2e-wli-1");

      // Same guarantee at the SQLite level: root vectors.db has zero rows for
      // the per-user (teacher) sessions, while the fail-closed captures ARE there.
      const rootVectorsDb = path.join(gw.dataDir, "vectors.db");
      expect(fs.existsSync(rootVectorsDb)).toBe(true);
      const teacherRows = await countRows(rootVectorsDb, "l0_conversations", ["sess-e2e-a-1", "sess-e2e-b-1"]);
      expect(teacherRows).toBe(0);
      const failClosedRows = await countRows(rootVectorsDb, "l0_conversations", ["sess-e2e-wli-1"]);
      expect(failClosedRows).toBeGreaterThan(0);

      // ── /seed: regular user → 403 with the exact guard body; main → 200 ──
      const seedPayload = {
        data: {
          sessions: [{
            sessionKey: "sess-e2e-seed-1",
            conversations: [[
              { role: "user", content: "seeded round: the cedar fence was repainted" },
              { role: "assistant", content: "ack seeded round" },
            ]],
          }],
        },
        // Keep the seed pipeline offline/deterministic: L0 only, no extraction.
        config_override: { extraction: { enabled: false } },
      };

      const forbidden = await postJson<SeedResponseJson & { error?: string }>(gw.baseUrl, "/seed", {
        ...seedPayload,
        user_id: "a",
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.json).toEqual({ error: "seed is not allowed for per-user stores" });
      // The 403 must not have seeded anything into the per-user store either.
      const seededIntoUserA = fs.readdirSync(path.join(gw.dataDir, "users", "a"))
        .filter((f) => f.startsWith("seed-"));
      expect(seededIntoUserA).toEqual([]);

      const allowed = await postJson<SeedResponseJson>(gw.baseUrl, "/seed", seedPayload);
      expect(allowed.status).toBe(200);
      expect(allowed.json.sessions_processed).toBe(1);
      expect(allowed.json.l0_recorded).toBeGreaterThan(0);
    } finally {
      await gw.stop();
    }
  });

  it("with TDAI_MULTI_USER off, the same requests all land in the main store", async () => {
    const gw = await startGateway({ port: PORT_LEGACY, multiUser: false });
    dumpLogsOnFailure(gw);

    try {
      // Same capture request that created users/a/ when the switch was on…
      const res = await captureRound(gw.baseUrl, {
        user_id: "a",
        session_key: "sess-e2e-legacy-a-1",
        user_content: "legacy round 1: the quartz shipment arrives tuesday",
        assistant_content: "ack legacy round 1",
      });
      expect(res.l0_recorded).toBeGreaterThan(0);

      // …now lands in the main store, reachable with or without a user_id.
      const searchWithUser = await searchConversationsUntilVisible(gw.baseUrl, "quartz", "a", "quartz");
      expect(searchWithUser.total).toBeGreaterThan(0);
      const searchAnonymous = await searchConversationsUntilVisible(gw.baseUrl, "quartz", undefined, "quartz");
      expect(searchAnonymous.total).toBeGreaterThan(0);

      // No per-user directory is created at all.
      expect(fs.existsSync(path.join(gw.dataDir, "users"))).toBe(false);
      expect(readAllJsonl(path.join(gw.dataDir, "conversations"))).toContain("sess-e2e-legacy-a-1");

      // And /seed with a user_id is no longer refused (everything is the main pool).
      const seed = await postJson<SeedResponseJson>(gw.baseUrl, "/seed", {
        data: {
          sessions: [{
            sessionKey: "sess-e2e-legacy-seed-1",
            conversations: [[
              { role: "user", content: "legacy seeded round: the cedar crate is heavy" },
              { role: "assistant", content: "ack legacy seeded round" },
            ]],
          }],
        },
        user_id: "a",
        config_override: { extraction: { enabled: false } },
      });
      expect(seed.status).toBe(200);
      expect(seed.json.sessions_processed).toBe(1);
      expect(seed.json.l0_recorded).toBeGreaterThan(0);
    } finally {
      await gw.stop();
    }
  });

  it("with TDAI_GATEWAY_API_KEY set: 401 without/wrong Bearer, 200 with it, /health stays open", async () => {
    const gw = await startGateway({ port: PORT_AUTH, multiUser: true, apiKey: "e2e-test-secret" });
    dumpLogsOnFailure(gw);

    try {
      // Missing Authorization header → 401.
      const noAuth = await postJson<ConversationSearchResponseJson>(gw.baseUrl, "/search/conversations", {
        query: "anything",
      });
      expect(noAuth.status).toBe(401);

      // Wrong token → 401.
      const wrongToken = await postJson<ConversationSearchResponseJson>(
        gw.baseUrl,
        "/search/conversations",
        { query: "anything" },
        { Authorization: "Bearer wrong-secret" },
      );
      expect(wrongToken.status).toBe(401);

      // Correct Bearer token → the route answers 200 (empty store, but not 401).
      const goodToken = await postJson<ConversationSearchResponseJson>(
        gw.baseUrl,
        "/search/conversations",
        { query: "anything", limit: 5 },
        { Authorization: "Bearer e2e-test-secret" },
      );
      expect(goodToken.status).toBe(200);
      expect(goodToken.json.total).toBe(0);

      // GET /health is deliberately unauthenticated (liveness probe contract).
      const health = await fetch(`${gw.baseUrl}/health`);
      expect(health.status).toBe(200);
    } finally {
      await gw.stop();
    }
  });

  it("runs the real L1 extraction pipeline per user: isolated l1_records + checkpoints, no cross-visibility", async () => {
    // Plan §7.2: prove per-user L1 isolation through the REAL extraction
    // pipeline (mock LLM → extraction parser → dedup → dual write), not just
    // the L0 path. The mock returns one static scene+memory for every
    // request, so the only per-user distinctions are real pipeline data:
    // session keys and captured content.
    const mock = await startMockLlmServer();
    const gw = await startGateway({
      port: PORT_L1_ISOLATION,
      multiUser: true,
      ownerUserIds: ["ops-admin"],
      extraEnv: {
        TDAI_LLM_BASE_URL: mock.baseUrl,
        TDAI_LLM_API_KEY: "test-key",
        TDAI_LLM_MODEL: "mock",
      },
      // Deterministic L1 triggering: warm-up's exponential threshold can be
      // inflated past the real conversation count by the cold-start capture
      // retry (a filtered attempt still notifies the pipeline), which would
      // leave extraction waiting on the 60s idle timer. A fixed threshold of
      // 2 fires L1 on the notify that follows a successfully recorded round —
      // and since the L1 runner reads L0 from the store (not the buffer),
      // that run always sees the round's messages.
      gatewayConfigFile: {
        memory: { pipeline: { enableWarmup: false, everyNConversations: 2 } },
      },
    });
    dumpLogsOnFailure(gw);

    const userVectorsDb = (uid: string) => path.join(gw.dataDir, "users", uid, "vectors.db");
    const userCheckpoint = (uid: string) => path.join(gw.dataDir, "users", uid, ".metadata", "recall_checkpoint.json");

    try {
      // ── each user captures ≥2 turns (fixed L1 trigger threshold 2) ──
      // Distinctive L0 tokens per user ("raven"/"falcon") — they exist in L0
      // only, never in the mock's canned L1 output.
      for (let round = 1; round <= 2; round++) {
        await captureRound(gw.baseUrl, {
          user_id: "a",
          session_key: "sess-l1-a-1",
          user_content: `round ${round} for user a: the raven ledger is kept in the attic`,
          assistant_content: `ack round ${round} for user a`,
        });
      }
      for (let round = 1; round <= 2; round++) {
        await captureRound(gw.baseUrl, {
          user_id: "b",
          session_key: "sess-l1-b-1",
          user_content: `round ${round} for user b: the falcon manifest is filed at noon`,
          assistant_content: `ack round ${round} for user b`,
        });
      }

      // ── the real extraction pipeline landed L1 records per user ──
      const pollWithLogs = async (what: string, predicate: () => Promise<boolean>) => {
        try {
          await pollUntil(predicate, L1_EXTRACTION_TIMEOUT_MS, what);
        } catch (err) {
          // The child's own logs are the only way to tell an extraction bug
          // from a mock/LLM hiccup — attach them to the failure.
          throw new Error(`${err instanceof Error ? err.message : String(err)}\n${gw.dumpLogs()}`);
        }
      };
      await pollWithLogs(
        "l1_records row for user a",
        () => countRows(userVectorsDb("a"), "l1_records", ["sess-l1-a-1"]).then((n) => n > 0),
      );
      await pollWithLogs(
        "l1_records row for user b",
        () => countRows(userVectorsDb("b"), "l1_records", ["sess-l1-b-1"]).then((n) => n > 0),
      );
      expect(mock.requestCount()).toBeGreaterThan(0); // the mock LLM was really used

      // ── checkpoint isolation: each user's checkpoint knows only its own session ──
      const readCheckpoint = (uid: string): string => {
        try {
          return fs.readFileSync(userCheckpoint(uid), "utf-8");
        } catch {
          return ""; // not written yet — pollUntil keeps waiting
        }
      };
      await pollUntil(
        () => readCheckpoint("a").includes("sess-l1-a-1"),
        L1_EXTRACTION_TIMEOUT_MS,
        "checkpoint runner state for user a",
      );
      await pollUntil(
        () => readCheckpoint("b").includes("sess-l1-b-1"),
        L1_EXTRACTION_TIMEOUT_MS,
        "checkpoint runner state for user b",
      );
      const cpA = readCheckpoint("a");
      const cpB = readCheckpoint("b");
      expect(cpA).not.toContain("sess-l1-b-1");
      expect(cpB).not.toContain("sess-l1-a-1");

      // ── cross-store isolation at the SQLite level (the hard regression lock):
      // a refactor that shares the store/cursor across users puts B's session
      // rows into A's vectors.db (or vice versa) and goes red here. ──
      const aTotal = await countRows(userVectorsDb("a"), "l1_records");
      const bTotal = await countRows(userVectorsDb("b"), "l1_records");
      expect(aTotal).toBeGreaterThan(0);
      expect(bTotal).toBeGreaterThan(0);
      expect(await countRows(userVectorsDb("a"), "l1_records", ["sess-l1-b-1"])).toBe(0);
      expect(await countRows(userVectorsDb("b"), "l1_records", ["sess-l1-a-1"])).toBe(0);
      // …and the main store never saw any of it.
      expect(await countRows(path.join(gw.dataDir, "vectors.db"), "l1_records", ["sess-l1-a-1", "sess-l1-b-1"])).toBe(0);

      // ── /search/memories isolation (FTS-only: no embedding configured) ──
      // Each user finds the extracted memory through their own store…
      const aSeesOwn = await searchMemoriesUntilVisible(gw.baseUrl, "violet morse sentinel", "a", MOCK_MEMORY_CONTENT);
      expect(aSeesOwn.total).toBeGreaterThan(0);
      const bSeesOwn = await searchMemoriesUntilVisible(gw.baseUrl, "violet morse sentinel", "b", MOCK_MEMORY_CONTENT);
      expect(bSeesOwn.total).toBeGreaterThan(0);

      // …and nothing referencing the other user (B's L0-only token never
      // surfaces in A's memory results, and vice versa).
      const aSeesB = await searchMemories(gw.baseUrl, "falcon manifest", "a");
      expect(aSeesB.total).toBe(0);
      expect(aSeesB.results).not.toContain("falcon");
      const bSeesA = await searchMemories(gw.baseUrl, "raven ledger", "b");
      expect(bSeesA.total).toBe(0);
      expect(bSeesA.results).not.toContain("raven");
    } finally {
      await gw.stop();
      await mock.close();
    }
  });
});
