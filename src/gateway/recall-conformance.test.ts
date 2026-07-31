import http from "node:http";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../config.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { MemoryRecord } from "../core/record/l1-writer.js";
import { VectorStore } from "../core/store/sqlite.js";
import { TdaiGateway } from "./server.js";
import type { RecallResponse } from "./types.js";

const HOST = "127.0.0.1";
const API_KEY = "gateway-api-key-do-not-log";
const EMBEDDING_API_KEY = "embedding-api-key-do-not-log";
const USER_ID = "gateway-user-id-do-not-log";
const PERSONA_MARKER = "PERSONA_CONFORMANCE_MARKER";
const SCENE_MARKER = "SCENE_CONFORMANCE_MARKER";
const L1_MARKER = "L1_CONFORMANCE_MARKER gatewayconformance";

const gateways: TdaiGateway[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0).reverse()) {
    await gateway.stop();
  }
  for (const dir of tempDirs.splice(0).reverse()) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tdai-gateway-recall-"));
  tempDirs.push(dataDir);
  await mkdir(path.join(dataDir, ".metadata"), { recursive: true });
  await mkdir(path.join(dataDir, "scene_blocks"), { recursive: true });
  return dataDir;
}

async function writeStableContext(dataDir: string): Promise<void> {
  await writeFile(path.join(dataDir, "persona.md"), PERSONA_MARKER, "utf8");
  await writeFile(
    path.join(dataDir, ".metadata", "scene_index.json"),
    JSON.stringify([
      {
        filename: "gateway-conformance.md",
        summary: SCENE_MARKER,
        heat: 10,
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
      },
    ]),
    "utf8",
  );
}

function l1Record(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 80,
    scene_name: "gateway-conformance",
    source_message_ids: ["source-1"],
    metadata: {},
    timestamps: ["2026-01-01T00:00:00.000Z"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessionKey: "fixture-session",
    sessionId: "fixture-session-id",
  };
}

function seedL1(dataDir: string, records: MemoryRecord[]): void {
  const store = new VectorStore(path.join(dataDir, "vectors.db"), 0);
  store.init();
  expect(store.isFtsAvailable()).toBe(true);
  for (const record of records) {
    expect(store.upsertL1(record, undefined)).toBe(true);
  }
  store.close();
}

async function unusedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP address");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function keywordMemoryConfig(): MemoryTdaiConfig {
  return parseConfig({
    extraction: { enabled: false },
    embedding: { provider: "none" },
    recall: {
      strategy: "keyword",
      maxResults: 5,
      scoreThreshold: 0,
      timeoutMs: 2_000,
    },
  });
}

async function startGateway(
  dataDir: string,
  memory: MemoryTdaiConfig = keywordMemoryConfig(),
): Promise<string> {
  const port = await unusedPort();
  const gateway = new TdaiGateway({
    server: { host: HOST, port, apiKey: API_KEY, corsOrigins: [] },
    data: { baseDir: dataDir },
    memory,
  });
  gateways.push(gateway);
  await gateway.start();
  return `http://${HOST}:${port}`;
}

async function recall(baseUrl: string): Promise<RecallResponse> {
  const response = await fetch(`${baseUrl}/recall`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      Connection: "close",
    },
    body: JSON.stringify({
      query: "gatewayconformance",
      session_key: "gateway-conformance-session",
      user_id: USER_ID,
    }),
  });
  expect(response.status).toBe(200);
  return await response.json() as RecallResponse;
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

describe.sequential("POST /recall conformance", () => {
  it("delivers stable and dynamic L1 context once in stable-first order", async () => {
    const dataDir = await makeDataDir();
    await writeStableContext(dataDir);
    seedL1(dataDir, [l1Record("l1-matching", L1_MARKER)]);

    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const baseUrl = await startGateway(dataDir);

    const first = await recall(baseUrl);
    const second = await recall(baseUrl);

    expect(first.memory_count).toBe(1);
    expect(first.strategy).toBe("keyword");
    expect(first.stable_context).toContain(PERSONA_MARKER);
    expect(first.stable_context).toContain(SCENE_MARKER);
    expect(first.dynamic_context).toContain(L1_MARKER);
    expect(occurrences(first.context, PERSONA_MARKER)).toBe(1);
    expect(occurrences(first.context, SCENE_MARKER)).toBe(1);
    expect(occurrences(first.context, L1_MARKER)).toBe(1);
    expect(first.context.indexOf(PERSONA_MARKER)).toBeLessThan(first.context.indexOf(L1_MARKER));
    expect(first.context).toBe(`${first.stable_context}\n\n${first.dynamic_context}`);
    expect(second).toEqual(first);

    const logs = [debug, info, warn, error]
      .flatMap((spy) => spy.mock.calls.flat())
      .map(String)
      .join("\n");
    for (const secret of [PERSONA_MARKER, SCENE_MARKER, L1_MARKER, USER_ID, API_KEY]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("does not count stable-only Persona and Scene content as L1 hits", async () => {
    const dataDir = await makeDataDir();
    await writeStableContext(dataDir);
    const baseUrl = await startGateway(dataDir);

    const response = await recall(baseUrl);

    expect(response.memory_count).toBe(0);
    expect(response.stable_context).toContain(PERSONA_MARKER);
    expect(response.stable_context).toContain(SCENE_MARKER);
    expect(response).not.toHaveProperty("dynamic_context");
    expect(response.context).toBe(response.stable_context);
  });

  it("keeps an L1 hit in the dynamic partition without Persona or Scene data", async () => {
    const dataDir = await makeDataDir();
    seedL1(dataDir, [l1Record("l1-without-profile", L1_MARKER)]);
    const baseUrl = await startGateway(dataDir);

    const response = await recall(baseUrl);

    expect(response.memory_count).toBe(1);
    expect(response.dynamic_context).toContain(L1_MARKER);
    expect(response.stable_context ?? "").not.toContain(PERSONA_MARKER);
    expect(response.stable_context ?? "").not.toContain(SCENE_MARKER);
    expect(response.context).toBe(
      [response.stable_context, response.dynamic_context].filter(Boolean).join("\n\n"),
    );
  });

  it("returns an explicit empty legacy context when recall finds nothing", async () => {
    const dataDir = await makeDataDir();
    const baseUrl = await startGateway(dataDir);

    const response = await recall(baseUrl);

    expect(response).toEqual({
      context: "",
      memory_count: 0,
    });
  });

  it("degrades to an empty response when the real recall path times out", async () => {
    const embeddingServer = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
      }, 75);
    });
    await new Promise<void>((resolve, reject) => {
      embeddingServer.once("error", reject);
      embeddingServer.listen(0, HOST, resolve);
    });
    const embeddingAddress = embeddingServer.address();
    if (!embeddingAddress || typeof embeddingAddress === "string") {
      throw new Error("Expected an embedding server TCP address");
    }

    try {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const dataDir = await makeDataDir();
      await writeStableContext(dataDir);
      const memory = parseConfig({
        extraction: { enabled: false },
        recall: { strategy: "embedding", timeoutMs: 10 },
        embedding: {
          provider: "openai",
          baseUrl: `http://${HOST}:${embeddingAddress.port}/v1`,
          apiKey: EMBEDDING_API_KEY,
          model: "conformance-embedding",
          dimensions: 2,
          timeoutMs: 1_000,
        },
      });
      const baseUrl = await startGateway(dataDir, memory);

      const response = await recall(baseUrl);

      expect(response).toEqual({ context: "", memory_count: 0 });
      expect(warn.mock.calls.flat().map(String).join("\n")).toContain("Recall timed out");

      // The timed-out work is not cancellable yet; let its local HTTP request
      // settle before closing the real SQLite store in afterEach.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const logs = [debug, info, warn, error]
        .flatMap((spy) => spy.mock.calls.flat())
        .map(String)
        .join("\n");
      for (const secret of [PERSONA_MARKER, USER_ID, API_KEY, EMBEDDING_API_KEY]) {
        expect(logs).not.toContain(secret);
      }
    } finally {
      embeddingServer.closeAllConnections();
      await new Promise<void>((resolve) => embeddingServer.close(() => resolve()));
    }
  });
});
