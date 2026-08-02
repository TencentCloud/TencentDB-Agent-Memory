/**
 * P3 — memory read routes (integration): boots a real TdaiGateway on a
 * scratch data dir with seeded memory files and exercises every GET route
 * plus the P2 write-gate contract on the reserved POST /memory/apply.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { TdaiGateway } from "./server.js";
import { parseConfig } from "../config.js";

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
    const { Database } = require("bun:sqlite") as { Database: new (p: string) => unknown };
    return new Database(dbPath) as unknown as {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): void };
      close(): void;
    };
  }
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => unknown };
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
    fs.writeFileSync(path.join(globalDir, "ok.md"), `${META}\n\nshort content`, "utf-8");
    fs.writeFileSync(path.join(globalDir, "big.md"), `${META}\n\n${"x".repeat(2000)}`, "utf-8");
    // oversized persona (limit 2000 chars)
    fs.writeFileSync(path.join(base, "persona.md"), "y".repeat(2500), "utf-8");
    // records with one malformed JSONL line
    fs.mkdirSync(path.join(base, "records"), { recursive: true });
    fs.writeFileSync(path.join(base, "records", "2026-08-02.jsonl"), '{"id":"a"}\n{broken json}\n', "utf-8");

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
    const res = await get(`/memory/records?since=${encodeURIComponent(since)}&type=persona&project=`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.records)).toBe(true);
  });

  it("GET /memory/records?project=projA (project-only filter on scoped schema) does not 500", async () => {
    // Regression: when neither since nor type is given, the project predicate
    // must be emitted as `WHERE project_id = ?` — a bare `AND project_id = ?`
    // after `FROM l1_records` is a syntax error (500 on scoped schemas).
    const res = await get(`/memory/records?project=${encodeURIComponent("projA")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const scoped = body.records.find((r: { record_id: string }) => r.record_id === "r-scoped");
    expect(scoped).toBeDefined();
    expect(scoped.project_id).toBe("projA");
    // Other projects must not leak in.
    const other = await get(`/memory/records?project=${encodeURIComponent("projB")}`);
    expect(other.status).toBe(200);
    const otherBody = await other.json();
    expect(otherBody.records.find((r: { record_id: string }) => r.record_id === "r-scoped")).toBeUndefined();
  });

  it("GET /memory/records project filter combines with since/type on scoped schema", async () => {
    const since = "2026-01-01T00:00:00Z";
    const res = await get(
      `/memory/records?project=${encodeURIComponent("projA")}&since=${encodeURIComponent(since)}&type=persona`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const scoped = body.records.find((r: { record_id: string }) => r.record_id === "r-scoped");
    expect(scoped).toBeDefined();
  });

  it("GET /memory/duplicates honors project-only filter on scoped schema (no 500)", async () => {
    const res = await get(`/memory/duplicates?project=${encodeURIComponent("projA")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.clusters)).toBe(true);
  });

  it("GET /memory/blocks reports limits and oversize flags", async () => {
    const res = await get("/memory/blocks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limits).toEqual({ scene: 1500, persona: 2000 });

    const big = body.blocks.find((b: { path: string }) => b.path.endsWith("big.md"));
    expect(big).toBeDefined();
    expect(big.over).toBe(true);
    expect(big.size).toBeGreaterThan(1500);

    const ok = body.blocks.find((b: { path: string }) => b.path.endsWith("ok.md"));
    expect(ok.over).toBe(false);

    const persona = body.blocks.find((b: { kind: string }) => b.kind === "persona");
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
      headers: { "x-memory-token": "deadbeef", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(wrongToken.status).toBe(401);
  });

  it("POST /memory/run follows the same write-gate", async () => {
    const noAuth = await fetch(`${baseUrl}/memory/run`, { method: "POST" });
    expect(noAuth.status).toBe(401);
    const info = await (await get("/memory/info")).json();
    const token = fs.readFileSync(info.tokenPath, "utf-8").trim();
    const authed = await fetch(`${baseUrl}/memory/run`, {
      method: "POST",
      headers: { "x-memory-token": token },
    });
    expect(authed.status).toBe(501);
  });
});
