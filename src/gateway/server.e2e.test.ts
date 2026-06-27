import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TdaiGateway } from "./server.js";
import type { GatewayConfig } from "./config.js";

/**
 * HTTP-level end-to-end tests for the Gateway + CoreRegistry multi-tenant
 * routing. These boot a real HTTP server backed by per-account SQLite stores,
 * so they live in the e2e suite (run via `vitest --config vitest.e2e.config.ts`)
 * rather than the default unit run — booting ~a dozen stores in parallel with
 * the fast unit files starves the background L0 indexer. No real LLM/embedding:
 * extraction off + provider "none" (keyword/FTS path).
 */

const baseOverrides = (baseDir: string, multiTenant: boolean): Partial<GatewayConfig> => ({
  server: { port: 0, host: "127.0.0.1", apiKey: undefined, corsOrigins: [] },
  data: { baseDir, multiTenant },
});

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function getJson(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/**
 * Poll conversation search until the owner's just-captured L0 is FTS-indexed.
 * Capture indexes L0 in a fire-and-forget background task, so a search issued
 * immediately after /capture can race ahead of indexing — poll the *positive*
 * (owner) case so the subsequent cross-tenant negative assertion is meaningful.
 */
async function pollSearchTotal(
  origin: string,
  sessionKey: string,
  query: string,
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let total = 0;
  while (Date.now() < deadline) {
    const r = await post(`${origin}/search/conversations`, { session_key: sessionKey, query });
    total = r.json?.total ?? 0;
    if (total > 0) return total;
    await new Promise((res) => setTimeout(res, 100));
  }
  return total;
}

describe("TdaiGateway HTTP wiring", () => {
  let baseDir: string;
  let gateway: TdaiGateway;
  let origin: string;

  afterEach(async () => {
    await gateway?.stop();
    if (baseDir) await fs.rm(baseDir, { recursive: true, force: true });
  });

  async function boot(multiTenant: boolean): Promise<void> {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-gw-"));
    gateway = new TdaiGateway(baseOverrides(baseDir, multiTenant));
    await gateway.start();
    const addr = gateway.address();
    if (!addr) throw new Error("gateway did not bind");
    origin = `http://127.0.0.1:${addr.port}`;
  }

  // One multi-tenant boot covers health/routing/capture/isolation/wipe so the
  // suite tears down few in-process gateways (each full teardown drains a SQLite
  // store + background indexer; many boots in one process starve each other).
  it("multi-tenant: end-to-end routing, L0 + persona isolation, and wipe", async () => {
    await boot(true);

    // Health: lazy, no cores yet.
    const health0 = await getJson(`${origin}/health`);
    expect(health0.json.multi_tenant).toBe(true);
    expect(health0.json.active_cores).toBe(0);

    // Routed endpoints require session_key.
    for (const ep of ["/recall", "/capture", "/search/memories", "/search/conversations"]) {
      const { status } = await post(`${origin}${ep}`, { query: "q", user_content: "u", assistant_content: "a" });
      expect(status, `${ep} should 400 without session_key`).toBe(400);
    }

    // /seed is refused in multi-tenant mode: it writes a shared snapshot dir,
    // not the per-account store, so a "successful" seed would be invisible to
    // recall/search. Even a well-formed body (session_key + data) must 400.
    const seedMt = await post(`${origin}/seed`, {
      session_key: "ai4all:alice",
      data: [{ sessionKey: "ai4all:alice", conversations: [[{ role: "user", content: "x" }, { role: "assistant", content: "y" }]] }],
    });
    expect(seedMt.status, "/seed should 400 in multi-tenant mode").toBe(400);

    // Capture two accounts. This is the FIRST capture to each freshly-created
    // account core, which is exactly the cold-start path: the gateway must stamp
    // the turn's messages strictly after the cold-start L0 cursor floor, so BOTH
    // the user and assistant message land. A regression here records 0 or 1 (the
    // user message silently filtered by a floor sitting in the same millisecond)
    // — assert the exact count, not just >0, to catch that.
    const capA = await post(`${origin}/capture`, {
      session_key: "ai4all:alice",
      user_content: "alice fact pineapple",
      assistant_content: "ok",
    });
    expect(capA.status).toBe(200);
    expect(capA.json.l0_recorded).toBe(2);
    const capB = await post(`${origin}/capture`, {
      session_key: "ai4all:bob",
      user_content: "bob fact coffee",
      assistant_content: "ok",
    });
    expect(capB.status).toBe(200);
    expect(capB.json.l0_recorded).toBe(2);

    // Two resident cores; two on-disk account dirs under baseDir.
    expect((await getJson(`${origin}/health`)).json.active_cores).toBe(2);
    const dirs = (await fs.readdir(baseDir)).filter((d) => !d.startsWith("seed-"));
    expect(dirs).toHaveLength(2);

    // Both accounts' L0 indexes and is searchable by its owner.
    expect(await pollSearchTotal(origin, "ai4all:alice", "pineapple")).toBeGreaterThan(0);
    expect(await pollSearchTotal(origin, "ai4all:bob", "coffee")).toBeGreaterThan(0);

    // Isolation: neither account can see the other's L0.
    const bobSeesAlice = await post(`${origin}/search/conversations`, { session_key: "ai4all:bob", query: "pineapple" });
    expect(bobSeesAlice.json.total).toBe(0);
    expect(bobSeesAlice.json.results).not.toContain("pineapple");
    const aliceSeesBob = await post(`${origin}/search/conversations`, { session_key: "ai4all:alice", query: "coffee" });
    expect(aliceSeesBob.json.total).toBe(0);

    // ── L3 (persona) isolation via /recall (design §8.4 #5) ──────────────────
    // Persona is a per-account file at `<accountDir>/persona.md`; recall reads it
    // fresh and injects it into `context` (appendSystemContext, <user-persona>).
    // Seed a distinct persona per account directly on disk (no LLM needed) and
    // assert each /recall sees ONLY its own — the structural per-account dataDir
    // is what keeps the upper Markdown layers isolated, not a query filter.
    const aliceDirEarly = (await fs.readdir(baseDir)).find((d) => d.startsWith("ai4all_alice"))!;
    const bobDirEarly = (await fs.readdir(baseDir)).find((d) => d.startsWith("ai4all_bob"))!;
    await fs.writeFile(path.join(baseDir, aliceDirEarly, "persona.md"), "Alice is a PINEAPPLE farmer.");
    await fs.writeFile(path.join(baseDir, bobDirEarly, "persona.md"), "Bob is a COFFEE roaster.");

    const aliceRecall = await post(`${origin}/recall`, { session_key: "ai4all:alice", query: "hello" });
    expect(aliceRecall.status).toBe(200);
    expect(aliceRecall.json.context).toContain("<user-persona>");
    expect(aliceRecall.json.context).toContain("PINEAPPLE farmer");
    expect(aliceRecall.json.context).not.toContain("COFFEE roaster"); // no leak from bob

    const bobRecall = await post(`${origin}/recall`, { session_key: "ai4all:bob", query: "hello" });
    expect(bobRecall.status).toBe(200);
    expect(bobRecall.json.context).toContain("COFFEE roaster");
    expect(bobRecall.json.context).not.toContain("PINEAPPLE"); // no leak from alice

    // Wipe alice → alice dir gone, bob intact and still searchable.
    const aliceDir = (await fs.readdir(baseDir)).find((d) => d.startsWith("ai4all_alice"))!;
    const bobDir = (await fs.readdir(baseDir)).find((d) => d.startsWith("ai4all_bob"))!;
    const wipe = await post(`${origin}/namespace/wipe`, { session_key: "ai4all:alice" });
    expect(wipe.status).toBe(200);
    expect(wipe.json.wiped).toBe(true);

    const dirsAfter = await fs.readdir(baseDir);
    expect(dirsAfter).not.toContain(aliceDir);
    expect(dirsAfter).toContain(bobDir);
    expect((await post(`${origin}/search/conversations`, { session_key: "ai4all:bob", query: "coffee" })).json.total).toBeGreaterThan(0);
    expect((await post(`${origin}/search/conversations`, { session_key: "ai4all:alice", query: "pineapple" })).json.total).toBe(0);
  });

  it("single-tenant: health reports the shared store, and wipe is rejected", async () => {
    await boot(false);

    const { status, json } = await getJson(`${origin}/health`);
    expect(status).toBe(200);
    expect(json.multi_tenant).toBe(false);
    expect(json.active_cores).toBeUndefined();

    const wipe = await post(`${origin}/namespace/wipe`, { session_key: "ai4all:alice" });
    expect(wipe.status).toBe(400);
  });
});
