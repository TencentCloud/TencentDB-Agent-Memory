/**
 * P3 — memory read routes (integration): boots a real TdaiGateway on a
 * scratch data dir with seeded memory files and exercises every GET route
 * plus the P2 write-gate contract on the reserved POST /memory/apply.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiGateway } from "./server.js";
import { parseConfig } from "../config.js";

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

    // vec-vs-meta: fresh store without vec0 tables → consistent null, counts known
    expect(body.checks.vecMeta.metaCount).toBe(0);
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

  it("POST /memory/apply: no token → 401; valid x-memory-token → 501 (reserved)", async () => {
    const noAuth = await fetch(`${baseUrl}/memory/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noAuth.status).toBe(401);

    const info = await (await get("/memory/info")).json();
    const token = fs.readFileSync(info.tokenPath, "utf-8").trim();
    const authed = await fetch(`${baseUrl}/memory/apply`, {
      method: "POST",
      headers: { "x-memory-token": token, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(authed.status).toBe(501);

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
