/**
 * tz-08 Ф0 — the server contract the consumer wrapper leans on.
 *
 * The wrapper is transport only, so every promise it makes to a host is really
 * a promise the SERVER makes. These are the three behaviours the wrapper reads
 * and reshapes, and the ones not already pinned by
 * `memory-routes.test.ts` (400 without query, 401, 415, 200 with the token):
 *
 *   1. `limit` is clamped to 1..50 server-side (default 5) — so the wrapper
 *      must not clamp it a second time, which would be a copy of server logic.
 *   2. a reindex answers 200 with `gated: true` and an EMPTY result — the
 *      shape the wrapper has to keep distinguishable from "nothing found".
 *   3. an empty note is refused with 400 — a bad request, not a silent no-op.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiGateway } from "../gateway/server.js";
import { parseConfig } from "../config.js";
import { freePort } from "../../scripts/tz08-probe/harness.mts";

let tmp: string;
let baseUrl: string;
let token: string;
let gateway: TdaiGateway;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-contract-"));
  const base = path.join(tmp, "tdai");
  fs.mkdirSync(base, { recursive: true });
  const port = await freePort();
  gateway = new TdaiGateway({
    data: { baseDir: base },
    server: { port, host: "127.0.0.1", corsOrigins: [] },
    memory: parseConfig({}),
  });
  await gateway.start();
  baseUrl = `http://127.0.0.1:${port}`;
  token = fs.readFileSync(path.join(tmp, "tdai-gateway.token"), "utf-8").trim();
});

afterAll(async () => {
  await gateway.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The core the gateway actually serves from — the reindex flag lives here. */
function core(): {
  getVectorStore(): { isReindexing?: () => boolean } | undefined;
  searchMemories(p: unknown): Promise<unknown>;
} {
  return (
    gateway as unknown as {
      core: {
        getVectorStore(): { isReindexing?: () => boolean } | undefined;
        searchMemories(p: unknown): Promise<unknown>;
      };
    }
  ).core;
}

describe("GET /memory/search — the contract the wrapper transports", () => {
  it("clamps limit to 1..50 server-side, so the wrapper never has to", async () => {
    const seen: number[] = [];
    const spy = vi
      .spyOn(core(), "searchMemories")
      .mockImplementation(async (p: unknown) => {
        seen.push((p as { limit: number }).limit);
        return { text: "", total: 0, strategy: "fts" };
      });
    try {
      for (const q of ["limit=999", "limit=0", "limit=-4", "limit=abc", ""]) {
        const res = await fetch(`${baseUrl}/memory/search?query=x&${q}`);
        expect([q, res.status]).toEqual([q, 200]);
      }
    } finally {
      spy.mockRestore();
    }
    // 999 → 50, 0 → 1, -4 → 1, "abc" → default 5, absent → default 5.
    expect(seen).toEqual([50, 1, 1, 5, 5]);
  });

  it("answers a reindex with gated:true and an empty result, not an error", async () => {
    const store = core().getVectorStore();
    expect(store).toBeDefined();
    const spy = vi
      .spyOn(store as { isReindexing: () => boolean }, "isReindexing")
      .mockReturnValue(true);
    try {
      const res = await fetch(`${baseUrl}/memory/search?query=anything`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: "",
        total: 0,
        strategy: "gated",
        gated: true,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("without the gate the same query is not marked gated", async () => {
    const res = await fetch(`${baseUrl}/memory/search?query=anything`);
    const body = (await res.json()) as { gated?: boolean; strategy: string };
    expect(res.status).toBe(200);
    expect(body.gated).toBeUndefined();
    expect(body.strategy).not.toBe("gated");
  });
});

describe("POST /memory/note — the contract the wrapper transports", () => {
  const post = (body: unknown) =>
    fetch(`${baseUrl}/memory/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-memory-token": token },
      body: JSON.stringify(body),
    });

  it("refuses an empty note with 400 instead of writing nothing quietly", async () => {
    for (const content of ["", "   ", undefined]) {
      const res = await post({ content });
      expect([String(content), res.status]).toEqual([String(content), 400]);
    }
  });

  it("refuses a note past the length cap with 400", async () => {
    const res = await post({ content: "x".repeat(10_001) });
    expect(res.status).toBe(400);
  });
});
