/**
 * DifyMemoryAdapter HTTP tests (offline).
 *
 * The adapter is started on an ephemeral port (port 0) with a fake
 * MemoryClient; requests are issued with global fetch against 127.0.0.1.
 * Covers the External Knowledge API contract (auth error codes 1001/1002,
 * knowledge routing, 2001 for unknown knowledge, top_k clamping, batch score
 * normalization + score_threshold filtering, no-items fallback) and the
 * /tools/* endpoints.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { DifyMemoryAdapter } from "./server.js";
import type { MemoryClient } from "../../adapter-sdk/index.js";

// ============================
// Fixtures
// ============================

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const MEMORY_ITEMS = [
  {
    id: "m1", content: "User prefers green tea", type: "persona", priority: 1,
    scene_name: "beverages", score: 0.92, created_at: "2026-01-01", updated_at: "2026-01-02",
  },
  {
    id: "m2", content: "User visited Shenzhen in May", type: "episodic", priority: 2,
    scene_name: "", score: 0.41, created_at: "2026-05-01", updated_at: "2026-05-01",
  },
];

const CONVERSATION_ITEMS = [
  {
    id: "c1", session_key: "dify:s1", role: "user",
    content: "How do I deploy the gateway?", score: 0.8, recorded_at: "2026-06-01",
  },
];

function createFakeClient(overrides: Partial<MemoryClient> = {}): MemoryClient {
  return {
    recall: vi.fn(async () => ({
      context: "known context", strategy: "hybrid", memoryCount: 3,
    })),
    capture: vi.fn(async () => ({ l0Recorded: 2, schedulerNotified: true })),
    searchMemories: vi.fn(async () => ({
      text: "formatted memories", total: 2, strategy: "hybrid", items: MEMORY_ITEMS,
    })),
    searchConversations: vi.fn(async () => ({
      text: "formatted conversations", total: 1, items: CONVERSATION_ITEMS,
    })),
    endSession: vi.fn(async () => {}),
    health: vi.fn(async () => ({ status: "ok" as const, vectorStore: true, embeddingService: true })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

let adapters: DifyMemoryAdapter[] = [];

async function startAdapter(opts: {
  client?: MemoryClient;
  apiKey?: string;
  defaultSessionKey?: string;
} = {}): Promise<{ adapter: DifyMemoryAdapter; base: string; client: MemoryClient }> {
  const client = opts.client ?? createFakeClient();
  const adapter = new DifyMemoryAdapter({
    client,
    port: 0,
    apiKey: opts.apiKey,
    defaultSessionKey: opts.defaultSessionKey,
    logger: silentLogger,
  });
  await adapter.start();
  adapters.push(adapter);
  return { adapter, base: `http://127.0.0.1:${adapter.boundPort}`, client };
}

afterEach(async () => {
  await Promise.all(adapters.map((a) => a.stop()));
  adapters = [];
});

function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function retrievalBody(knowledgeId: string, extra: Record<string, unknown> = {}) {
  return {
    knowledge_id: knowledgeId,
    query: "tea",
    retrieval_setting: { top_k: 5, score_threshold: 0 },
    ...extra,
  };
}

// ============================
// /retrieval — happy paths
// ============================

describe("DifyMemoryAdapter — POST /retrieval", () => {
  it("maps tdai-memories items to Dify records (content/score/title/metadata)", async () => {
    const { base, client } = await startAdapter();

    const res = await post(base, "/retrieval", retrievalBody("tdai-memories"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(client.searchMemories).toHaveBeenCalledWith({ query: "tea", limit: 5 });
    expect(body.records).toEqual([
      {
        content: "User prefers green tea",
        score: 1, // batch-normalized: top hit = 1.0
        title: "beverages",
        metadata: { id: "m1", type: "persona", scene_name: "beverages", created_at: "2026-01-01" },
      },
      {
        content: "User visited Shenzhen in May",
        score: 0.41 / 0.92, // batch-normalized (raw / batch max)
        title: "episodic", // no scene_name → falls back to type
        metadata: { id: "m2", type: "episodic", scene_name: "", created_at: "2026-05-01" },
      },
    ]);
  });

  it("maps tdai-conversations items with role@session titles", async () => {
    const { base, client } = await startAdapter();

    const res = await post(base, "/retrieval", retrievalBody("tdai-conversations"));

    const body = await res.json();
    expect(client.searchConversations).toHaveBeenCalledWith({ query: "tea", limit: 5 });
    expect(body.records).toEqual([
      {
        content: "How do I deploy the gateway?",
        score: 1, // batch-normalized: top hit = 1.0
        title: "user@dify:s1",
        metadata: { id: "c1", role: "user", session_key: "dify:s1", recorded_at: "2026-06-01" },
      },
    ]);
  });

  it("clamps top_k into 1..20 and defaults missing retrieval_setting", async () => {
    const { base, client } = await startAdapter();

    await post(base, "/retrieval", retrievalBody("tdai-memories", {
      retrieval_setting: { top_k: 999, score_threshold: 0 },
    }));
    expect(client.searchMemories).toHaveBeenLastCalledWith({ query: "tea", limit: 20 });

    await post(base, "/retrieval", { knowledge_id: "tdai-memories", query: "tea" });
    expect(client.searchMemories).toHaveBeenLastCalledWith({ query: "tea", limit: 5 });
  });

  it("filters records below score_threshold (after batch normalization)", async () => {
    const { base } = await startAdapter();

    const res = await post(base, "/retrieval", retrievalBody("tdai-memories", {
      retrieval_setting: { top_k: 5, score_threshold: 0.5 },
    }));

    const body = await res.json();
    // 0.92 → 1.0 survives; 0.41 → 0.41/0.92 ≈ 0.446 is filtered out.
    expect(body.records).toHaveLength(1);
    expect(body.records[0].score).toBe(1);
  });

  it("hybrid RRF raw scores (≈0.03) survive a 0.5 threshold thanks to batch normalization", async () => {
    // RRF replaces scores with 1/(60+rank+1) sums, capping near 2/61 ≈ 0.033.
    // Without normalization a realistic Dify threshold would drop everything.
    const client = createFakeClient({
      searchMemories: vi.fn(async () => ({
        text: "rrf", total: 2, strategy: "hybrid",
        items: [
          { ...MEMORY_ITEMS[0], score: 0.0328 },
          { ...MEMORY_ITEMS[1], score: 0.0161 },
        ],
      })),
    });
    const { base } = await startAdapter({ client });

    const res = await post(base, "/retrieval", retrievalBody("tdai-memories", {
      retrieval_setting: { top_k: 5, score_threshold: 0.5 },
    }));

    const body = await res.json();
    // Top hit normalizes to 1.0 and passes; 0.0161/0.0328 ≈ 0.491 < 0.5.
    expect(body.records).toHaveLength(1);
    expect(body.records[0].content).toBe("User prefers green tea");
    expect(body.records[0].score).toBe(1);
  });

  it("falls back to one formatted-text record when the backend returns no items but total > 0", async () => {
    const client = createFakeClient({
      searchMemories: vi.fn(async () => ({
        text: "legacy formatted text", total: 3, strategy: "fts", items: [],
      })),
    });
    const { base } = await startAdapter({ client });

    const res = await post(base, "/retrieval", retrievalBody("tdai-memories"));

    const body = await res.json();
    expect(body.records).toEqual([
      { content: "legacy formatted text", score: 1, title: "tdai-memories" },
    ]);
  });

  it("returns empty records when nothing matches", async () => {
    const client = createFakeClient({
      searchMemories: vi.fn(async () => ({ text: "", total: 0, strategy: "none", items: [] })),
    });
    const { base } = await startAdapter({ client });

    const res = await post(base, "/retrieval", retrievalBody("tdai-memories"));

    expect((await res.json()).records).toEqual([]);
  });

  it("unknown knowledge_id → 404 with error_code 2001", async () => {
    const { base } = await startAdapter();

    const res = await post(base, "/retrieval", retrievalBody("someone-elses-kb"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error_code: 2001,
      error_msg: "The knowledge does not exist",
    });
  });

  it("missing query → 400 with error_code 4000", async () => {
    const { base } = await startAdapter();

    const res = await post(base, "/retrieval", { knowledge_id: "tdai-memories" });

    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe(4000);
  });

  it("malformed JSON body → 400 with error_code 4000 (client fault, not a 500)", async () => {
    const { base } = await startAdapter();

    const res = await fetch(`${base}/retrieval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{{{ not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_code).toBe(4000);
    expect(body.error_msg).toContain("Invalid JSON body");
  });
});

// ============================
// Auth — Dify error-code semantics
// ============================

describe("DifyMemoryAdapter — auth", () => {
  it("missing/malformed Authorization → 403 error_code 1001", async () => {
    const { base } = await startAdapter({ apiKey: "dify-secret" });

    const missing = await post(base, "/retrieval", retrievalBody("tdai-memories"));
    expect(missing.status).toBe(403);
    expect((await missing.json()).error_code).toBe(1001);

    const malformed = await post(base, "/retrieval", retrievalBody("tdai-memories"), {
      Authorization: "Basic dXNlcjpwYXNz",
    });
    expect(malformed.status).toBe(403);
    expect((await malformed.json()).error_code).toBe(1001);
  });

  it("wrong key → 403 error_code 1002", async () => {
    const { base } = await startAdapter({ apiKey: "dify-secret" });

    const res = await post(base, "/retrieval", retrievalBody("tdai-memories"), {
      Authorization: "Bearer wrong-key",
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error_code: 1002, error_msg: "Authorization failed" });
  });

  it("correct key passes; /health and /openapi.json stay open", async () => {
    const { base } = await startAdapter({ apiKey: "dify-secret" });

    const ok = await post(base, "/retrieval", retrievalBody("tdai-memories"), {
      Authorization: "Bearer dify-secret",
    });
    expect(ok.status).toBe(200);

    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/openapi.json`)).status).toBe(200);
  });

  it("without a configured key the adapter runs open (legacy gateway posture)", async () => {
    const { base } = await startAdapter();

    const res = await post(base, "/retrieval", retrievalBody("tdai-memories"));

    expect(res.status).toBe(200);
  });
});

// ============================
// /tools/* — memory WRITE + recall
// ============================

describe("DifyMemoryAdapter — /tools endpoints", () => {
  it("/tools/capture maps the wire body onto client.capture", async () => {
    const { base, client } = await startAdapter({ defaultSessionKey: "dify:app-42" });

    const res = await post(base, "/tools/capture", {
      user_content: "I moved to Chengdu",
      assistant_content: "Congrats on the move!",
      session_id: "run-7",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ l0_recorded: 2, scheduler_notified: true });
    expect(client.capture).toHaveBeenCalledWith({
      userContent: "I moved to Chengdu",
      assistantContent: "Congrats on the move!",
      sessionKey: "dify:app-42", // default applied
      sessionId: "run-7",
    });
  });

  it("/tools/capture honours an explicit session_key and validates required fields", async () => {
    const { base, client } = await startAdapter();

    await post(base, "/tools/capture", {
      user_content: "u", assistant_content: "a", session_key: "dify:custom",
    });
    expect(client.capture).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionKey: "dify:custom" }),
    );

    const bad = await post(base, "/tools/capture", { user_content: "only-user" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error_code).toBe(4000);
  });

  it("/tools/recall returns context/strategy/memory_count", async () => {
    const { base, client } = await startAdapter();

    const res = await post(base, "/tools/recall", { query: "where do I live?" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      context: "known context", strategy: "hybrid", memory_count: 3,
    });
    expect(client.recall).toHaveBeenCalledWith({
      query: "where do I live?", sessionKey: "dify:default",
    });
  });

  it("client failures surface as 500 with a Dify-style error body", async () => {
    const client = createFakeClient({
      recall: vi.fn(async () => {
        throw new Error("gateway down");
      }),
    });
    const { base } = await startAdapter({ client });

    const res = await post(base, "/tools/recall", { query: "q" });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error_code).toBe(5000);
    expect(body.error_msg).toContain("gateway down");
  });
});

// ============================
// /health
// ============================

describe("DifyMemoryAdapter — GET /health", () => {
  it("reports upstream health when the client responds", async () => {
    const { base } = await startAdapter();

    const body = await (await fetch(`${base}/health`)).json();

    expect(body.status).toBe("ok");
    expect(body.platform).toBe("dify");
    expect(body.upstream).toEqual({ status: "ok", vectorStore: true, embeddingService: true });
  });

  it("never throws — reports 'unreachable' when the upstream probe fails", async () => {
    const client = createFakeClient({
      health: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    const { base } = await startAdapter({ client });

    const res = await fetch(`${base}/health`);

    expect(res.status).toBe(200);
    expect((await res.json()).upstream).toBe("unreachable");
  });
});
