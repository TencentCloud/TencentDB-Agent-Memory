/**
 * HttpMemoryClient ⇄ REAL TdaiGateway wire-compatibility e2e test.
 *
 * Excluded from the default suite (`*.e2e.test.ts`); run with:
 *   npx vitest run --config vitest.e2e.config.ts src/adapter-sdk
 *
 * Boots an actual `TdaiGateway` (real TdaiCore, sqlite store) on an ephemeral
 * port with a temp data dir, extraction disabled, and embedding provider
 * "none" — fully offline, no API keys. Proves the SDK's HTTP transport speaks
 * the same wire dialect as the gateway end-to-end, including the
 * `include_items` extension and Bearer auth.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TdaiGateway } from "../../gateway/server.js";
import { parseConfig } from "../../config.js";
import { HttpMemoryClient } from "./http.js";
import { MemoryClientError } from "../errors.js";

const API_KEY = "e2e-secret";

let gateway: TdaiGateway;
let dataDir: string;
let baseUrl: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-e2e-"));
  gateway = new TdaiGateway({
    server: { port: 0, host: "127.0.0.1", apiKey: API_KEY, corsOrigins: [] },
    data: { baseDir: dataDir },
    // Extraction/persona need an LLM — disable for offline determinism.
    memory: parseConfig({
      extraction: { enabled: false },
      persona: { enabled: false },
      recall: { enabled: true },
      capture: { enabled: true },
    }),
  });
  await gateway.start();
  baseUrl = `http://127.0.0.1:${gateway.boundPort}`;
});

afterAll(async () => {
  await gateway?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("HttpMemoryClient against a real TdaiGateway", () => {
  it("health reports the real store flags", async () => {
    const client = new HttpMemoryClient({ baseUrl, apiKey: API_KEY });

    const health = await client.health();

    expect(["ok", "degraded"]).toContain(health.status);
    expect(typeof health.vectorStore).toBe("boolean");
    expect(health.version).toBeTruthy();
  });

  it("rejects a wrong Bearer token with code 'auth'", async () => {
    const client = new HttpMemoryClient({ baseUrl, apiKey: "wrong" });

    const err = await client.recall({ query: "q", sessionKey: "s" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MemoryClientError);
    expect((err as MemoryClientError).code).toBe("auth");
  });

  it("captures a turn, searches it back (include_items), recalls, and flushes", async () => {
    const client = new HttpMemoryClient({ baseUrl, apiKey: API_KEY, timeoutMs: 30_000 });
    const sessionKey = "e2e-session";

    const capture = await client.capture({
      userContent: "My favourite framework is Zephyrium",
      assistantContent: "Zephyrium noted as your favourite framework.",
      sessionKey,
    });
    expect(capture.l0Recorded).toBeGreaterThan(0);

    // L0 conversation search over the freshly captured turn (FTS path —
    // embedding provider is "none"). Wire shape must include items when the
    // gateway supports include_items.
    const search = await client.searchConversations({ query: "Zephyrium", limit: 5 });
    expect(typeof search.text).toBe("string");
    expect(Array.isArray(search.items)).toBe(true);
    if (search.total > 0) {
      expect(search.text).toContain("Zephyrium");
      expect(search.items.length).toBeGreaterThan(0);
      expect(search.items[0]).toHaveProperty("session_key");
      expect(search.items[0]).toHaveProperty("role");
      expect(search.items[0]).toHaveProperty("score");
    }

    // Memory (L1) search: nothing extracted (extraction off) — but the wire
    // must still answer cleanly with the structured shape.
    const memories = await client.searchMemories({ query: "Zephyrium" });
    expect(typeof memories.text).toBe("string");
    expect(Array.isArray(memories.items)).toBe(true);

    // Recall + session end must round-trip without error.
    const recall = await client.recall({ query: "What framework do I like?", sessionKey });
    expect(typeof recall.context).toBe("string");
    expect(typeof recall.memoryCount).toBe("number");

    await expect(client.endSession(sessionKey)).resolves.toBeUndefined();
  });
});
