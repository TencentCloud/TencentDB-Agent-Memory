/**
 * P3 — memory read routes (integration): boots a real TdaiGateway on a
 * scratch data dir with seeded memory files and exercises every GET route
 * plus the P2 write-gate contract on the reserved POST /memory/apply.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { TdaiGateway } from "./server.js";
import { parseConfig } from "../config.js";

// Real gateway boot calls sweepKeeperOrphans(null) on start — stub it so a
// live gateway's keeper sub-sessions on this host are never SIGKILLed by the
// test suite (cf. acceptance-criteria.test.ts:42).
vi.mock("./consolidation/child-spawn.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./consolidation/child-spawn.js")>();
  return {
    ...actual,
    sweepKeeperOrphans: vi.fn(() => 0),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const require = createRequire(import.meta.url);

/**
 * Open a SQLite DB read-write on the current test runtime (bun:sqlite under
 * Bun, node:sqlite under Node — mirrors http-utils.openReadonlySqlite).
 */
function openSqlite(dbPath: string): {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
  close(): void;
} {
  if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
    const { Database } = require("bun:sqlite") as {
      Database: new (p: string) => unknown;
    };
    return new Database(dbPath) as unknown as {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): void };
      close(): void;
    };
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => unknown;
  };
  return new DatabaseSync(dbPath) as unknown as {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): void };
    close(): void;
  };
}

/**
 * Add the scoping columns to l1_records and insert one project-scoped row,
 * simulating the I3/I4 scoped schema the gateway may run against. The store
 * migration already ran at init, so the ALTERs fail with "duplicate column"
 * if a scoped schema is already present — that is fine (try/catch).
 */
function seedScopedL1Record(base: string): void {
  const db = openSqlite(path.join(base, "vectors.db"));
  try {
    try {
      db.exec("ALTER TABLE l1_records ADD COLUMN project_id TEXT DEFAULT ''");
      db.exec("ALTER TABLE l1_records ADD COLUMN scope TEXT DEFAULT 'global'");
    } catch {
      // Columns already exist — scoped schema was already set up.
    }
    db.prepare(
      "INSERT INTO l1_records " +
        "(record_id, content, type, priority, scene_name, session_key, session_id, " +
        "timestamp_str, created_time, updated_time, metadata_json, project_id, scope) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "r-scoped",
      "project scoped memory content",
      "persona",
      80,
      "",
      "s-scoped",
      "",
      "",
      "2026-08-01T00:00:00Z",
      "2026-08-01T00:00:00Z",
      "{}",
      "projA",
      "project",
    );
  } finally {
    db.close();
  }
}

const META = [
  "-----META-START-----",
  "created: 2026-08-02T00:00:00Z",
  "updated: 2026-08-02T00:00:00Z",
  "summary: seeded test block",
  "heat: 1",
  "-----META-END-----",
].join("\n");

describe("memory read routes (P3, integration)", () => {
  let tmp: string;
  let base: string;
  let port: number;
  let gateway: TdaiGateway;
  let baseUrl: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-routes-"));
    base = path.join(tmp, "tdai");

    // scene blocks (one in-limit, one oversized)
    const globalDir = path.join(base, "scene_blocks", "_global");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "ok.md"),
      `${META}\n\nshort content`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(globalDir, "big.md"),
      `${META}\n\n${"x".repeat(2000)}`,
      "utf-8",
    );
    // oversized persona (limit 2000 chars)
    fs.writeFileSync(path.join(base, "persona.md"), "y".repeat(2500), "utf-8");
    // records with one malformed JSONL line
    fs.mkdirSync(path.join(base, "records"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "records", "2026-08-02.jsonl"),
      '{"id":"a"}\n{broken json}\n',
      "utf-8",
    );

    port = 28_000 + Math.floor(Math.random() * 500);
    gateway = new TdaiGateway({
      data: { baseDir: base },
      server: { port, host: "127.0.0.1", corsOrigins: [] },
      memory: parseConfig({}),
    });
    await gateway.start();
    // Simulate the scoped schema (I3/I4): project_id/scope columns + one
    // project-scoped record. Exercises the project-only filter path that
    // regressed into `FROM l1_records AND project_id = ?` (syntax error).
    seedScopedL1Record(base);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const get = (p: string) => fetch(`${baseUrl}${p}`);

  it("GET /memory/info returns dataDir/tokenPath/version (auth-free)", async () => {
    const res = await get("/memory/info");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dataDir).toBe(base);
    expect(body.tokenPath).toBe(path.join(tmp, "tdai-gateway.token"));
    expect(typeof body.version).toBe("string");
    // discovery exposes only the PATH, never the credential
    expect(fs.existsSync(body.tokenPath)).toBe(true);
    expect("token" in body).toBe(false);
    expect("secret" in body).toBe(false);
  });

  it("GET /memory/records returns 200 with a records array", async () => {
    const res = await get("/memory/records");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe("number");
    expect(Array.isArray(body.records)).toBe(true);
  });

  it("GET /memory/records honors the since/project/type filters", async () => {
    const since = "2026-01-01T00:00:00Z";
    const res = await get(
      `/memory/records?since=${encodeURIComponent(since)}&type=persona&project=`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.records)).toBe(true);
  });

  it("GET /memory/records?project=projA (project-only filter on scoped schema) does not 500", async () => {
    // Regression: when neither since nor type is given, the project predicate
    // must be emitted as `WHERE project_id = ?` — a bare `AND project_id = ?`
    // after `FROM l1_records` is a syntax error (500 on scoped schemas).
    const res = await get(
      `/memory/records?project=${encodeURIComponent("projA")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const scoped = body.records.find(
      (r: { record_id: string }) => r.record_id === "r-scoped",
    );
    expect(scoped).toBeDefined();
    expect(scoped.project_id).toBe("projA");
    // Other projects must not leak in.
    const other = await get(
      `/memory/records?project=${encodeURIComponent("projB")}`,
    );
    expect(other.status).toBe(200);
    const otherBody = await other.json();
    expect(
      otherBody.records.find(
        (r: { record_id: string }) => r.record_id === "r-scoped",
      ),
    ).toBeUndefined();
  });

  it("GET /memory/records project filter combines with since/type on scoped schema", async () => {
    const since = "2026-01-01T00:00:00Z";
    const res = await get(
      `/memory/records?project=${encodeURIComponent("projA")}&since=${encodeURIComponent(since)}&type=persona`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const scoped = body.records.find(
      (r: { record_id: string }) => r.record_id === "r-scoped",
    );
    expect(scoped).toBeDefined();
  });

  it("GET /memory/duplicates honors project-only filter on scoped schema (no 500)", async () => {
    const res = await get(
      `/memory/duplicates?project=${encodeURIComponent("projA")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.clusters)).toBe(true);
  });

  it("GET /memory/blocks reports limits and oversize flags", async () => {
    const res = await get("/memory/blocks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limits).toEqual({ scene: 1500, persona: 2000 });

    const big = body.blocks.find((b: { path: string }) =>
      b.path.endsWith("big.md"),
    );
    expect(big).toBeDefined();
    expect(big.over).toBe(true);
    expect(big.size).toBeGreaterThan(1500);

    const ok = body.blocks.find((b: { path: string }) =>
      b.path.endsWith("ok.md"),
    );
    expect(ok.over).toBe(false);

    const persona = body.blocks.find(
      (b: { kind: string }) => b.kind === "persona",
    );
    expect(persona.over).toBe(true);
    expect(persona.limit).toBe(2000);
  });

  it("GET /memory/validate reports sizes, JSON integrity, META, vec-meta", async () => {
    const res = await get("/memory/validate");
    expect(res.status).toBe(200);
    const body = await res.json();

    // sizes: persona (2500 chars) + big.md (2000+ chars) over limit
    expect(body.checks.sizes.overLimit.length).toBeGreaterThanOrEqual(2);
    expect(body.checks.sizes.checked).toBeGreaterThanOrEqual(3);

    // JSON integrity: the seeded records file has one malformed line
    expect(body.checks.json.valid).toBe(false);
    expect(body.checks.json.malformed.length).toBe(1);
    expect(body.checks.json.malformed[0].file).toMatch(/^records\//);

    // META frontmatter present on both seeded scene blocks
    expect(body.checks.meta.valid).toBe(true);
    expect(body.checks.meta.checked).toBeGreaterThanOrEqual(2);

    // vec-vs-meta: no vec0 tables → consistent null, counts known. metaCount
    // is 1 because seedScopedL1Record inserted one project-scoped row.
    expect(body.checks.vecMeta.metaCount).toBe(1);
    expect(body.checks.vecMeta.consistent).toBeNull();
  });

  it("GET /memory/duplicates answers 200 with a clusters array (no LLM)", async () => {
    // The scratch store has no embedding provider: the route either degrades
    // (store not ready) or returns empty clusters — never an error.
    const res = await get("/memory/duplicates?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.clusters)).toBe(true);
    if (body.degraded === false) {
      expect(body.total).toBe(body.clusters.length);
      expect(body.topK).toBeGreaterThan(0);
    }
  });

  it("POST /memory/apply: no token → 401; valid x-memory-token → 400 (invalid diff)", async () => {
    const noAuth = await fetch(`${baseUrl}/memory/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noAuth.status).toBe(401);

    const info = await (await get("/memory/info")).json();
    const token = fs.readFileSync(info.tokenPath, "utf-8").trim();
    // P4 implemented the route: an empty body is an invalid diff → 400, and
    // the response carries the structured abort result (no partial apply).
    const authed = await fetch(`${baseUrl}/memory/apply`, {
      method: "POST",
      headers: { "x-memory-token": token, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(authed.status).toBe(400);
    const body = (await authed.json()) as { status: string; partial: boolean };
    expect(body.status).toBe("aborted");
    expect(body.partial).toBe(false);

    const wrongToken = await fetch(`${baseUrl}/memory/apply`, {
      method: "POST",
      headers: {
        "x-memory-token": "deadbeef",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(wrongToken.status).toBe(401);
  });

  it("POST /memory/run follows the same write-gate and answers 202", async () => {
    const noAuth = await fetch(`${baseUrl}/memory/run`, { method: "POST" });
    expect(noAuth.status).toBe(401);
    const info = await (await get("/memory/info")).json();
    const token = fs.readFileSync(info.tokenPath, "utf-8").trim();
    const authed = await fetch(`${baseUrl}/memory/run`, {
      method: "POST",
      headers: { "x-memory-token": token },
    });
    // P6 implemented the route: async 202 + status. Consolidation is disabled
    // in this scratch config, so the trigger reports "disabled" (fail-open).
    expect(authed.status).toBe(202);
    const body = (await authed.json()) as { accepted: boolean; status: string };
    expect(body.accepted).toBe(false);
    expect(body.status).toBe("disabled");
  });

  it("GET /status reports consolidation state (P6)", async () => {
    const res = await get("/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.consolidation).toBeDefined();
    expect(body.consolidation.enabled).toBe(false);
    expect(String(body.consolidation.checkpoint)).toContain(
      "consolidation_checkpoint.json",
    );
    expect(body.consolidation.inFlight).toBe(false);
  });

  // Regression: /status used to be registered TWICE. The first branch served a
  // consolidation-only body and the second — the one README-STATUS.md
  // documents (counters/totals/lastError) — was unreachable. One handler now
  // serves both, so this asserts the documented fields alongside P6.
  it("GET /status serves the documented counters/totals AND the consolidation block", async () => {
    const body = (await (await get("/status")).json()) as Record<
      string,
      unknown
    >;
    expect(body.counters).toBeDefined();
    expect(body.totals).toBeDefined();
    expect(body).toHaveProperty("lastError");
    expect(body).toHaveProperty("vectorStore");
    expect(body.consolidation).toBeDefined();
    // tz-09 Ф1: control-plane projection, empty on a store with no runs.
    expect(Array.isArray(body.runs)).toBe(true);
  });

  // ============================
  // GET /memory/blocks?path= — read CONTENT of one addressable block (keeper
  // tools fetch_blocks.py). Sanitized: allowlist (scene_blocks/** + persona.md),
  // reject .. / absolute / empty, realpath containment, symlink-escape → 400.
  // ============================

  it("GET /memory/blocks?path=scene_blocks/_global/ok.md → 200 + content", async () => {
    const res = await get(
      "/memory/blocks?path=" + encodeURIComponent("scene_blocks/_global/ok.md"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("scene");
    expect(body.content).toContain("short content");
  });

  it("GET /memory/blocks?path=persona.md → 200 (second allowlist member)", async () => {
    const res = await get("/memory/blocks?path=persona.md");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("persona");
    expect(body.content.length).toBe(2500);
  });

  it("GET /memory/blocks?path=../../etc/passwd → 400 (traversal)", async () => {
    const res = await get(
      "/memory/blocks?path=" + encodeURIComponent("../../etc/passwd"),
    );
    expect(res.status).toBe(400);
  });

  it("GET /memory/blocks?path=%2e%2e/etc/passwd → 400 (encoded traversal)", async () => {
    const res = await get("/memory/blocks?path=%2e%2e/etc/passwd");
    expect(res.status).toBe(400);
  });

  it("GET /memory/blocks?path=/abs → 400 (absolute)", async () => {
    const res = await get("/memory/blocks?path=" + encodeURIComponent("/abs"));
    expect(res.status).toBe(400);
  });

  it("GET /memory/blocks?path=~ → 400 (tilde)", async () => {
    const res = await get("/memory/blocks?path=~");
    expect(res.status).toBe(400);
  });

  it("GET /memory/blocks?path=memory_health.md → 400 (not in allowlist)", async () => {
    fs.writeFileSync(path.join(base, "memory_health.md"), "health", "utf-8");
    const res = await get("/memory/blocks?path=memory_health.md");
    expect(res.status).toBe(400);
  });

  it("GET /memory/blocks?path=scene_blocks/_global/missing.md → 404", async () => {
    const res = await get(
      "/memory/blocks?path=" +
        encodeURIComponent("scene_blocks/_global/missing.md"),
    );
    expect(res.status).toBe(404);
  });

  it("GET /memory/blocks?path=scene_blocks → 400 (dir, not a file)", async () => {
    const res = await get("/memory/blocks?path=scene_blocks");
    expect(res.status).toBe(400);
  });

  it("GET /memory/blocks?path=<cyrillic> → 200 (Unicode allowlist)", async () => {
    const cyr = "scene_blocks/_global/технический-отчет.md";
    fs.writeFileSync(
      path.join(base, "scene_blocks", "_global", "технический-отчет.md"),
      `${META}\n\ncyrillic body`,
      "utf-8",
    );
    const res = await get("/memory/blocks?path=" + encodeURIComponent(cyr));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("cyrillic body");
  });

  it("GET /memory/blocks?path=<symlink escape> → 400 (realpath containment)", async () => {
    const linkPath = path.join(base, "scene_blocks", "_global", "link.md");
    try {
      fs.symlinkSync("/etc/passwd", linkPath);
    } catch {
      // Symlinks may be unavailable on some filesystems — skip the probe.
      return;
    }
    const res = await get(
      "/memory/blocks?path=" +
        encodeURIComponent("scene_blocks/_global/link.md"),
    );
    expect(res.status).toBe(400);
    fs.unlinkSync(linkPath);
  });
});

// ============================
// P8 reindex-in-progress route gate (ТЗ §5.6): while a full reindex is
// running, /recall + /search/memories + /search/conversations return EMPTY
// 200 (fail-open), never an error. The flag lives on the vector store; the
// store-level flag mechanics are covered in reindex-integration.test.ts —
// here we exercise the HTTP routes against the flag being on.
// ============================

describe("reindex-in-progress route gate (P8)", () => {
  let tmp: string;
  let base: string;
  let port: number;
  let gateway: TdaiGateway;
  let baseUrl: string;
  // core is private on the gateway (compile-time only) — reach the store
  // through the instance for the isReindexing spy.
  let store: { isReindexing(): boolean };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-reindex-gate-"));
    base = path.join(tmp, "tdai");
    fs.mkdirSync(path.join(base, "scene_blocks", "_global"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(base, "records"), { recursive: true });
    port = 28_500 + Math.floor(Math.random() * 500);
    gateway = new TdaiGateway({
      data: { baseDir: base },
      server: { port, host: "127.0.0.1", corsOrigins: [] },
      memory: parseConfig({}),
    });
    await gateway.start();
    const core = (
      gateway as unknown as {
        core: { getVectorStore(): { isReindexing(): boolean } | undefined };
      }
    ).core;
    store = core.getVectorStore()!;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const post = (p: string, body: unknown) =>
    fetch(`${baseUrl}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("during a full reindex the read routes return EMPTY 200 (fail-open), never an error", async () => {
    const flagSpy = vi.spyOn(store, "isReindexing").mockReturnValue(true);
    const core = (
      gateway as unknown as {
        core: {
          handleBeforeRecall(...args: unknown[]): Promise<unknown>;
          searchMemories(...args: unknown[]): Promise<unknown>;
          searchConversations(...args: unknown[]): Promise<unknown>;
        };
      }
    ).core;
    const recallSpy = vi.spyOn(core, "handleBeforeRecall");
    const memoriesSpy = vi.spyOn(core, "searchMemories");
    const conversationsSpy = vi.spyOn(core, "searchConversations");
    try {
      const recall = await post("/recall", {
        query: "anything",
        session_key: "s-gate",
      });
      expect(recall.status).toBe(200);
      expect(await recall.json()).toEqual({
        context: "",
        strategy: "gated",
        memory_count: 0,
      });

      const memories = await post("/search/memories", { query: "anything" });
      expect(memories.status).toBe(200);
      expect(await memories.json()).toEqual({
        results: "",
        total: 0,
        strategy: "gated",
      });

      const conversations = await post("/search/conversations", {
        query: "anything",
      });
      expect(conversations.status).toBe(200);
      expect(await conversations.json()).toEqual({ results: "", total: 0 });

      // The routes short-circuit at the gate — the core is never reached.
      expect(recallSpy).not.toHaveBeenCalled();
      expect(memoriesSpy).not.toHaveBeenCalled();
      expect(conversationsSpy).not.toHaveBeenCalled();

      // /status mirrors the flag.
      const status = await (await fetch(`${baseUrl}/status`)).json();
      expect(status.reindexInProgress).toBe(true);
    } finally {
      flagSpy.mockRestore();
      recallSpy.mockRestore();
      memoriesSpy.mockRestore();
      conversationsSpy.mockRestore();
    }
  });

  it("gate off (default): /status reports reindexInProgress=false and the routes reach the core", async () => {
    expect(store.isReindexing()).toBe(false);
    const status = await (await fetch(`${baseUrl}/status`)).json();
    expect(status.reindexInProgress).toBe(false);
    const memories = await post("/search/memories", { query: "anything" });
    expect(memories.status).toBe(200);
    const body = (await memories.json()) as { strategy?: string };
    expect(body.strategy).not.toBe("gated"); // no gate marker — normal path ran
  });
});

// ============================
// P10 memory tools routes (#12) + feedback loop (#4)
// ============================

describe("memory tools + feedback routes (P10, integration)", () => {
  let tmp: string;
  let base: string;
  let port: number;
  let gateway: TdaiGateway;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-tools-"));
    base = path.join(tmp, "tdai");
    fs.mkdirSync(base, { recursive: true });

    port = 29_000 + Math.floor(Math.random() * 500);
    gateway = new TdaiGateway({
      data: { baseDir: base },
      server: { port, host: "127.0.0.1", corsOrigins: [] },
      memory: parseConfig({}),
    });
    await gateway.start();
    token = fs
      .readFileSync(path.join(tmp, "tdai-gateway.token"), "utf-8")
      .trim();
    baseUrl = `http://127.0.0.1:${port}`;

    // Seed one feedback target record (priority 40).
    const db = openSqlite(path.join(base, "vectors.db"));
    db.prepare(
      "INSERT INTO l1_records " +
        "(record_id, content, type, priority, scene_name, session_key, session_id, " +
        "timestamp_str, created_time, updated_time, metadata_json) " +
        "VALUES (?, ?, ?, ?, '', '', '', '', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '{}')",
    ).run(
      "fb-target",
      "Feedback target content with a long enough prefix to be a dedup key",
      "episodic",
      40,
    );
    db.close();
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const get = (p: string) => fetch(`${baseUrl}${p}`);
  const postJson = (
    p: string,
    body: unknown,
    headers?: Record<string, string>,
  ) =>
    fetch(`${baseUrl}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const readPriority = (recordId: string): number => {
    const db = openSqlite(path.join(base, "vectors.db"));
    try {
      const row = (
        db as unknown as {
          prepare(sql: string): { get(...params: unknown[]): unknown };
        }
      )
        .prepare("SELECT priority FROM l1_records WHERE record_id = ?")
        .get(recordId) as { priority: number } | undefined;
      return row?.priority ?? -1;
    } finally {
      db.close();
    }
  };

  it("GET /memory/search?query= returns 200 with results shape (auth-free)", async () => {
    const res = await get("/memory/search?query=feedback");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.results).toBe("string");
    expect(typeof body.total).toBe("number");
    expect(typeof body.strategy).toBe("string");
  });

  it("GET /memory/search without query returns 400", async () => {
    const res = await get("/memory/search");
    expect(res.status).toBe(400);
  });

  it("POST /memory/note without token → 401 (write-gate)", async () => {
    const res = await postJson("/memory/note", { content: "a note" });
    expect(res.status).toBe(401);
  });

  it("POST /memory/note with loopback token records an L0 note", async () => {
    const res = await postJson(
      "/memory/note",
      { content: "remember this detail", session_key: "s-note" },
      { "x-memory-token": token },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.l0_recorded).toBe("number");
    expect(typeof body.scheduler_notified).toBe("boolean");
    expect(body.session_key).toBe("s-note");
  });

  it("POST /memory/note with wrong Content-Type → 415", async () => {
    const res = await fetch(`${baseUrl}/memory/note`, {
      method: "POST",
      headers: { "x-memory-token": token, "Content-Type": "text/plain" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(415);
  });

  it("POST /memory/feedback without token → 401", async () => {
    const res = await postJson("/memory/feedback", {
      keys: ["Feedback target"],
    });
    expect(res.status).toBe(401);
  });

  it("POST /memory/feedback bumps priority of startsWith-matched records", async () => {
    const res = await postJson(
      "/memory/feedback",
      {
        keys: [
          "Feedback target content with a long enough prefix to be a dedup key",
        ],
      },
      { "x-memory-token": token },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matched).toBe(1);
    expect(body.bumped).toBe(1);
    expect(readPriority("fb-target")).toBe(41); // 40 + 1 (positive, capped)
  });

  it("POST /memory/feedback with invalid body → 400", async () => {
    const res = await postJson(
      "/memory/feedback",
      { keys: "nope" },
      { "x-memory-token": token },
    );
    expect(res.status).toBe(400);
  });
});
