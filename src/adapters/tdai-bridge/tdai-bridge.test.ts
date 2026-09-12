import { describe, it, expect, vi } from "vitest";
import { TdaiBridge } from "./tdai-bridge.js";

// 模拟 HTTP 错误类 - 更真实的错误对象（继承 Error，有 status 字段）
class HttpErr extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
    this.name = "HttpErr";
  }
}

// 模拟 GatewayClient 接口的实现
function makeClient(overrides: Partial<GatewayClient> = {}) {
  return {
    recall: vi.fn(),
    capture: vi.fn(),
    searchMemories: vi.fn(),
    searchConversations: vi.fn(),
    endSession: vi.fn(),
    ...overrides,
  } as unknown as GatewayClient;
}

// 本地接口定义（与实现中保持一致）
interface GatewayClient {
  recall(body: { query: string; session_key: string }): Promise<{ context: string }>;
  capture(body: { user_text: string; assistant_text: string; session_key: string }): Promise<unknown>;
  searchMemories(body: { query: string; limit: number }): Promise<unknown>;
  searchConversations(body: { query: string; limit: number }): Promise<unknown>;
  endSession(body: { session_key: string }): Promise<unknown>;
}

describe("TdaiBridge retry", () => {
  it("retries transient (status 503) then succeeds", async () => {
    const client = makeClient({
      recall: vi.fn()
        .mockRejectedValueOnce(new HttpErr(503, "busy"))
        .mockResolvedValueOnce({ context: "OK" }),
    });
    const bridge = new TdaiBridge(client, { retry: { attempts: 3, baseMs: 1 } });
    const res = await bridge.recall("hello", "sess-1");
    expect(client.recall).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ context: "OK" });
  });

  it("does NOT retry auth errors (status 401)", async () => {
    const client = makeClient({
      recall: vi.fn().mockRejectedValue(new HttpErr(401, "no key")),
    });
    const bridge = new TdaiBridge(client, { retry: { attempts: 3, baseMs: 1 } });
    // 降级: recall 失败返回空串,不抛
    const res = await bridge.recall("hello", "sess-1");
    expect(client.recall).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ context: "" });
  });

  it("does NOT retry validation errors (status 400)", async () => {
    const client = makeClient({
      recall: vi.fn().mockRejectedValue(new HttpErr(400, "invalid input")),
    });
    const bridge = new TdaiBridge(client, { retry: { attempts: 3, baseMs: 1 } });
    const res = await bridge.recall("hello", "sess-1");
    expect(client.recall).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ context: "" });
  });

  it("retries on network errors (TypeError)", async () => {
    const client = makeClient({
      recall: vi.fn()
        .mockRejectedValueOnce(new TypeError("network error"))
        .mockResolvedValueOnce({ context: "OK" }),
    });
    const bridge = new TdaiBridge(client, { retry: { attempts: 3, baseMs: 1 } });
    const res = await bridge.recall("hello", "sess-1");
    expect(client.recall).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ context: "OK" });
  });
});

describe("TdaiBridge graceful degradation", () => {
  it("capture returns {ok:false} on error", async () => {
    const client = makeClient({
      capture: vi.fn().mockRejectedValue(new HttpErr(500, "server error")),
    });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });
    const res = await bridge.capture({ userText: "hi", assistantText: "hello" }, "sess-1");
    expect(res).toEqual({ ok: false });
  });

  it("searchMemory returns [] on error", async () => {
    const client = makeClient({
      searchMemories: vi.fn().mockRejectedValue(new HttpErr(429, "rate limit")),
    });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });
    const res = await bridge.searchMemory("test");
    expect(res).toEqual([]);
  });

  it("searchConversation returns [] on error", async () => {
    const client = makeClient({
      searchConversations: vi.fn().mockRejectedValue(new HttpErr(503, "unavailable")),
    });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });
    const res = await bridge.searchConversation("test");
    expect(res).toEqual([]);
  });

  it("endSession logs warning but does not throw", async () => {
    const client = makeClient({
      endSession: vi.fn().mockRejectedValue(new HttpErr(500, "server error")),
    });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });
    await expect(bridge.endSession("sess-1")).resolves.toBeUndefined();
  });
});

describe("TdaiBridge cache & sanitize", () => {
  it("recall 同会话同查询命中缓存(只调一次 client)", async () => {
    const client = makeClient({ recall: vi.fn().mockResolvedValue({ context: "X" }) });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });
    await bridge.recall("q", "s");
    await bridge.recall("q", "s");
    expect(client.recall).toHaveBeenCalledTimes(1);
  });

  it("recall 不同会话不同查询不命中缓存", async () => {
    const client = makeClient({ recall: vi.fn().mockResolvedValue({ context: "X" }) });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });
    await bridge.recall("q1", "s1");
    await bridge.recall("q2", "s2");
    expect(client.recall).toHaveBeenCalledTimes(2);
  });

  it("输入超长被截断(query)", async () => {
    const client = makeClient({ recall: vi.fn().mockResolvedValue({ context: "X" }) });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });
    const longQuery = "x".repeat(200_000);
    await bridge.recall(longQuery, "s");
    expect((client.recall as any).mock.calls[0][0].query.length).toBe(100_000);
  });

  it("输入超长被截断(user_text/assistant_text)", async () => {
    const client = makeClient({ capture: vi.fn().mockResolvedValue({}) });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });
    await bridge.capture({ userText: "x".repeat(2_000_000), assistantText: "y".repeat(2_000_000) }, "s");
    const callArgs = (client.capture as any).mock.calls[0][0];
    expect(callArgs.user_text.length).toBe(1_000_000);
    expect(callArgs.assistant_text.length).toBe(1_000_000);
  });

  it("limit 参数被 clamp 到 1..50 范围", async () => {
    const client = makeClient({ searchMemories: vi.fn().mockResolvedValue([]) });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });

    await bridge.searchMemory("test", { limit: 0 });
    expect((client.searchMemories as any).mock.calls[0][0].limit).toBe(1);

    await bridge.searchMemory("test", { limit: 100 });
    expect((client.searchMemories as any).mock.calls[1][0].limit).toBe(50);
  });

  it("缓存超出上限时清空", async () => {
    const client = makeClient({ recall: vi.fn().mockResolvedValue({ context: "X" }) });
    const bridge = new TdaiBridge(client, { recallCacheMax: 3, retry: { attempts: 1, baseMs: 1 } });

    // 填充缓存到上限
    await bridge.recall("q1", "s1");
    await bridge.recall("q2", "s2");
    await bridge.recall("q3", "s3");

    // 第4个应该触发清空
    await bridge.recall("q4", "s4");

    // 再次查询 q1 应该不命中缓存（因为被清空了）
    await bridge.recall("q1", "s1");

    // 总共应该调用 5 次 client (q1,q2,q3,q4,q1)
    expect(client.recall).toHaveBeenCalledTimes(5);
  });

  it("sanitize 处理非字符串输入", async () => {
    const client = makeClient({ recall: vi.fn().mockResolvedValue({ context: "X" }) });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });

    // 测试 null, undefined, 和其他类型
    // 用不同 sessionKey 避免缓存命中(非字符串 sanitize 成 "" 会撞同一个缓存 key)
    await bridge.recall(null as any, "s1");
    await bridge.recall(undefined as any, "s2");
    await bridge.recall(12345 as any, "s3");

    // 所有非字符串应该被转换为空字符串
    expect(client.recall).toHaveBeenCalledTimes(3);
    expect((client.recall as any).mock.calls[0][0].query).toBe("");
    expect((client.recall as any).mock.calls[1][0].query).toBe("");
    expect((client.recall as any).mock.calls[2][0].query).toBe("");
  });
});