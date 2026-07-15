import { describe, it, expect, vi, afterEach } from "vitest";
import { TdaiHttpClient, TdaiClientError } from "./client";

// ─── fetch mock helpers ─────────────────────────────────────────────────────
//
// 复刻 src/utils/no-think-fetch.test.ts 的模式：
//   vi.spyOn(globalThis, "fetch").mockImplementation(...) + afterEach(restoreAllMocks)
// 不同场景需要不同的 mock 行为（队列返回 / 队列抛错 / 挂起等待 abort），
// 故抽出三个 helper。

interface FetchCall {
  input: unknown;
  init: RequestInit | undefined;
}

/**
 * 按队列依次返回 Response 或抛 Error，用于测试重试序列
 * （如「先 500 后 200」「先网络错误后成功」）。队列耗尽后重复最后一项。
 */
function mockSequence(items: Array<Response | Error>): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    const item = items[Math.min(i, items.length - 1)];
    i++;
    if (item instanceof Error) throw item;
    // clone() 避免 body 被多次消费
    return item.clone();
  }) as typeof globalThis.fetch);
  return { calls };
}

/** 单一固定 Response（mockSequence 的便捷封装）。 */
function mockSingle(res: Response): { calls: FetchCall[] } {
  return mockSequence([res]);
}

/**
 * 永不 resolve；仅当传入的 signal abort 时 reject 一个 AbortError。
 * 用于测试超时——配合短 timeouts.recall 让真实 setTimeout 触发 controller.abort()。
 */
function mockHangUntilAbort(): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    const signal = init?.signal as AbortSignal | undefined;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
        return;
      }
      signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  }) as typeof globalThis.fetch);
  return { calls };
}

/** 从捕获的 init.body 中解析 JSON。 */
function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (!init?.body) return {};
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("TdaiHttpClient", () => {
  // ─── constructor: baseUrl 规整 ─────────────────────────────────────────────

  describe("constructor — baseUrl 规整", () => {
    it("去掉单个尾斜杠", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://127.0.0.1:8420/" });
      await c.health();
      expect(calls[0].input).toBe("http://127.0.0.1:8420/health");
    });

    it("去掉多个尾斜杠", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://127.0.0.1:8420///" });
      await c.health();
      expect(calls[0].input).toBe("http://127.0.0.1:8420/health");
    });
  });

  // ─── Bearer 鉴权 ────────────────────────────────────────────────────────────

  describe("Bearer 鉴权", () => {
    it("apiKey 设置时发 Authorization: Bearer <key>", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x", apiKey: "secret123" });
      await c.health();
      const headers = new Headers(calls[0].init!.headers);
      expect(headers.get("authorization")).toBe("Bearer secret123");
    });

    it("apiKey 未设置时不发 Authorization 头", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      await c.health();
      const headers = new Headers(calls[0].init!.headers);
      expect(headers.get("authorization")).toBeNull();
    });

    it("apiKey 为纯空白时视为未设置（不发头）", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x", apiKey: "   " });
      await c.health();
      const headers = new Headers(calls[0].init!.headers);
      expect(headers.get("authorization")).toBeNull();
    });

    it("apiKey 两端空白被 trim", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x", apiKey: "  secret  " });
      await c.health();
      const headers = new Headers(calls[0].init!.headers);
      expect(headers.get("authorization")).toBe("Bearer secret");
    });

    it("Content-Type 始终为 application/json", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      await c.recall("q", "s");
      const headers = new Headers(calls[0].init!.headers);
      expect(headers.get("content-type")).toBe("application/json");
    });
  });

  // ─── 请求体翻译 (camelCase → snake_case) ──────────────────────────────────

  describe("请求体翻译 camelCase → snake_case", () => {
    it("recall 发 {query, session_key, user_id} 到 POST /recall", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      await c.recall("你好", "sess-1", "u1");
      expect(calls[0].init!.method).toBe("POST");
      expect(calls[0].input).toBe("http://x/recall");
      expect(jsonBody(calls[0].init)).toEqual({
        query: "你好",
        session_key: "sess-1",
        user_id: "u1",
      });
    });

    it("recall 不传 userId 时 user_id 被 JSON.stringify 丢弃", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      await c.recall("hi", "s1");
      const body = jsonBody(calls[0].init);
      expect(body).toEqual({ query: "hi", session_key: "s1" });
      expect("user_id" in body).toBe(false);
    });

    it("capture 发 snake_case 并透传 opts 到 POST /capture", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      await c.capture("u-text", "a-text", "sess-1", {
        sessionId: "sid",
        userId: "uid",
        messages: [{ role: "user", content: "x" }],
      });
      expect(calls[0].input).toBe("http://x/capture");
      expect(jsonBody(calls[0].init)).toEqual({
        user_content: "u-text",
        assistant_content: "a-text",
        session_key: "sess-1",
        session_id: "sid",
        user_id: "uid",
        messages: [{ role: "user", content: "x" }],
      });
    });

    it("searchMemories 发 {query, limit, type, scene} 到 POST /search/memories", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      await c.searchMemories({ query: "q", limit: 5, type: "preference", scene: "s" });
      expect(calls[0].input).toBe("http://x/search/memories");
      expect(jsonBody(calls[0].init)).toEqual({
        query: "q",
        limit: 5,
        type: "preference",
        scene: "s",
      });
    });

    it("searchConversations 发 {query, limit, session_key} 到 POST /search/conversations", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      await c.searchConversations({ query: "q", limit: 3, sessionKey: "sk" });
      expect(calls[0].input).toBe("http://x/search/conversations");
      expect(jsonBody(calls[0].init)).toEqual({
        query: "q",
        limit: 3,
        session_key: "sk",
      });
    });

    it("endSession 发 {session_key, user_id} 到 POST /session/end", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      await c.endSession("sess-1", "u1");
      expect(calls[0].input).toBe("http://x/session/end");
      expect(jsonBody(calls[0].init)).toEqual({ session_key: "sess-1", user_id: "u1" });
    });

    it("health 发 GET /health 且无 body", async () => {
      const { calls } = mockSingle(new Response("{}", { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      await c.health();
      expect(calls[0].init!.method).toBe("GET");
      expect(calls[0].init!.body).toBeUndefined();
      expect(calls[0].input).toBe("http://x/health");
    });
  });

  // ─── 成功响应解析 ───────────────────────────────────────────────────────────

  describe("成功响应解析", () => {
    it("recall 返回解析后的 RecallResponse", async () => {
      mockSingle(
        new Response(
          JSON.stringify({ context: "ctx", strategy: "hybrid", memory_count: 3 }),
          { status: 200 },
        ),
      );
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const r = await c.recall("q", "s");
      expect(r).toEqual({ context: "ctx", strategy: "hybrid", memory_count: 3 });
    });

    it("endSession resolve 为 undefined（void）", async () => {
      mockSingle(new Response(JSON.stringify({ flushed: true }), { status: 200 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const r = await c.endSession("s");
      expect(r).toBeUndefined();
    });
  });

  // ─── 超时 (AbortError → TIMEOUT) ───────────────────────────────────────────

  describe("超时 — AbortError 映射为 TIMEOUT", () => {
    it("超时抛 TdaiClientError code=TIMEOUT status=0 endpoint=/recall", async () => {
      mockHangUntilAbort();
      const c = new TdaiHttpClient({
        baseUrl: "http://x",
        timeouts: { recall: 50 },
      });
      const err = await c.recall("q", "s").catch((e) => e);
      expect(err).toBeInstanceOf(TdaiClientError);
      const e = err as TdaiClientError;
      expect(e.code).toBe("TIMEOUT");
      expect(e.status).toBe(0);
      expect(e.endpoint).toBe("/recall");
      expect(e.message).toContain("50ms");
    });

    it("超时不重试——仅 1 次 fetch 调用", async () => {
      const { calls } = mockHangUntilAbort();
      const c = new TdaiHttpClient({
        baseUrl: "http://x",
        timeouts: { recall: 50 },
      });
      await c.recall("q", "s").catch(() => {});
      expect(calls).toHaveLength(1);
    });
  });

  // ─── 5xx 重试 1 次 ─────────────────────────────────────────────────────────

  describe("5xx 重试 1 次", () => {
    it("500 → 200：重试后成功，共 2 次调用", async () => {
      const { calls } = mockSequence([
        new Response(JSON.stringify({ error: "boom", code: "INTERNAL" }), { status: 500 }),
        new Response(JSON.stringify({ context: "ok" }), { status: 200 }),
      ]);
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const r = await c.recall("q", "s");
      expect(r).toEqual({ context: "ok" });
      expect(calls).toHaveLength(2);
    });

    it("503 → 200：重试后成功", async () => {
      const { calls } = mockSequence([
        new Response("{}", { status: 503 }),
        new Response(JSON.stringify({ context: "ok" }), { status: 200 }),
      ]);
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const r = await c.recall("q", "s");
      expect(r).toEqual({ context: "ok" });
      expect(calls).toHaveLength(2);
    });

    it("连续 500：重试 1 次后仍失败，抛 status=500，共 2 次调用", async () => {
      const { calls } = mockSequence([
        new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
        new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
      ]);
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const err = await c.recall("q", "s").catch((e) => e);
      expect(err).toBeInstanceOf(TdaiClientError);
      const e = err as TdaiClientError;
      expect(e.status).toBe(500);
      expect(e.message).toBe("boom");
      expect(e.code).toBeUndefined();
      expect(e.endpoint).toBe("/recall");
      expect(calls).toHaveLength(2);
    });
  });

  // ─── 网络错误重试 1 次 ─────────────────────────────────────────────────────

  describe("网络错误（非 AbortError）重试 1 次", () => {
    it("TypeError → 200：重试后成功，共 2 次调用", async () => {
      const { calls } = mockSequence([
        new TypeError("fetch failed"),
        new Response(JSON.stringify({ context: "ok" }), { status: 200 }),
      ]);
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const r = await c.recall("q", "s");
      expect(r).toEqual({ context: "ok" });
      expect(calls).toHaveLength(2);
    });

    it("连续 TypeError：重试 1 次后仍失败，抛 code=NETWORK_ERROR status=0", async () => {
      const { calls } = mockSequence([
        new TypeError("fetch failed"),
        new TypeError("fetch failed"),
      ]);
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const err = await c.recall("q", "s").catch((e) => e);
      expect(err).toBeInstanceOf(TdaiClientError);
      const e = err as TdaiClientError;
      expect(e.code).toBe("NETWORK_ERROR");
      expect(e.status).toBe(0);
      expect(e.endpoint).toBe("/recall");
      expect(e.message).toContain("fetch failed");
      expect(calls).toHaveLength(2);
    });
  });

  // ─── 4xx 不重试 ─────────────────────────────────────────────────────────────

  describe("4xx 不重试——立即抛错", () => {
    it("404：抛 status=404，仅 1 次调用", async () => {
      const { calls } = mockSingle(
        new Response(JSON.stringify({ error: "Not found", code: "NOT_FOUND" }), {
          status: 404,
        }),
      );
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const err = await c.recall("q", "s").catch((e) => e);
      expect(err).toBeInstanceOf(TdaiClientError);
      const e = err as TdaiClientError;
      expect(e.status).toBe(404);
      expect(e.code).toBe("NOT_FOUND");
      expect(e.message).toBe("Not found");
      expect(calls).toHaveLength(1);
    });

    it("401：抛 status=401", async () => {
      const { calls } = mockSingle(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      );
      const c = new TdaiHttpClient({ baseUrl: "http://x", apiKey: "wrong" });
      const err = await c.recall("q", "s").catch((e) => e);
      expect((err as TdaiClientError).status).toBe(401);
      expect(calls).toHaveLength(1);
    });

    it("400：抛 status=400，仅 1 次调用", async () => {
      const { calls } = mockSingle(
        new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
      );
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      await c.capture("u", "a", "s").catch(() => {});
      expect(calls).toHaveLength(1);
    });
  });

  // ─── 错误体映射 ─────────────────────────────────────────────────────────────

  describe("错误体映射", () => {
    it("Gateway 返回 {error, code} → message + code 透传", async () => {
      mockSingle(
        new Response(JSON.stringify({ error: "validation failed", code: "E_VALIDATION" }), {
          status: 422,
        }),
      );
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const err = await c.recall("q", "s").catch((e) => e);
      const e = err as TdaiClientError;
      expect(e.status).toBe(422);
      expect(e.message).toBe("validation failed");
      expect(e.code).toBe("E_VALIDATION");
    });

    it("空 body → message=HTTP <status>，code=undefined", async () => {
      mockSingle(new Response("", { status: 500 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const err = await c.recall("q", "s").catch((e) => e);
      const e = err as TdaiClientError;
      // 注意：第一次 500 会重试；第二次仍是空 500 → 最终抛错
      expect(e.status).toBe(500);
      expect(e.message).toBe("HTTP 500");
      expect(e.code).toBeUndefined();
    });

    it("非 JSON 文本 → message=原文", async () => {
      // 用 4xx 避免触发重试，便于断言单次
      mockSingle(new Response("plain text error", { status: 400 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const err = await c.recall("q", "s").catch((e) => e);
      const e = err as TdaiClientError;
      expect(e.status).toBe(400);
      expect(e.message).toBe("plain text error");
      expect(e.code).toBeUndefined();
    });

    it("JSON 但无 error/code 字段 → message=HTTP <status>", async () => {
      mockSingle(new Response(JSON.stringify({ unrelated: "x" }), { status: 400 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const err = await c.recall("q", "s").catch((e) => e);
      const e = err as TdaiClientError;
      expect(e.message).toBe("HTTP 400");
      expect(e.code).toBeUndefined();
    });
  });

  // ─── endpoint 字段 ──────────────────────────────────────────────────────────

  describe("endpoint 字段透传", () => {
    it("searchMemories 错误时 endpoint=/search/memories", async () => {
      mockSingle(new Response(JSON.stringify({ error: "x" }), { status: 400 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      const err = await c.searchMemories({ query: "q" }).catch((e) => e);
      expect((err as TdaiClientError).endpoint).toBe("/search/memories");
    });

    it("health 错误时 endpoint=/health", async () => {
      mockSingle(new Response(JSON.stringify({ error: "down" }), { status: 503 }));
      const c = new TdaiHttpClient({ baseUrl: "http://x" });
      // 503 会重试 1 次，两次都失败后抛错
      const err = await c.health().catch((e) => e);
      expect((err as TdaiClientError).endpoint).toBe("/health");
    });
  });
});
