import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "../types.js";
import {
  opikApiPrefix,
  opikCreateLlmSpan,
  opikCreateTrace,
  opikEndpoint,
  flushOpikBatchQueue,
  opikQuestionTag,
  opikReportFailure,
  opikTurnTag,
  opikTurnTraceId,
  opikUpdateTrace,
  opikUpdateTraceFork,
  resetOpikClientForTests,
} from "../opik.js";

const BASE = "http://opik.test";

function mkConfig(overrides: Partial<ProxyConfig["opik"]> = {}): ProxyConfig {
  return {
    opik: {
      enabled: true,
      url: BASE,
      apiKey: "test-key",
      apiPrefix: "/v1/private",
      timeoutMs: 1,
      stripRequestLogContent: false,
      requestLogEnabled: false,
      batch: {
        enabled: true,
        maxBatchSize: 20,
        flushIntervalMs: 1000,
      },
      ...overrides,
    },
  } as unknown as ProxyConfig;
}

function okResponse(): Response {
  return { ok: true, status: 200, text: async () => "" } as unknown as Response;
}

function failResponse(): Response {
  return { ok: false, status: 500, text: async () => "boom" } as unknown as Response;
}

function httpResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => "" } as unknown as Response;
}

async function flush(): Promise<void> {
  await flushOpikBatchQueue();
  await new Promise((r) => setTimeout(r, 2));
}

describe("opik client 可靠性加固", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetOpikClientForTests();
    fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("关闭或未配 url 时零网络开销", () => {
    expect(opikCreateTrace(mkConfig({ enabled: false }), traceInput())).toBe("");
    expect(opikCreateTrace(mkConfig({ url: "" }), traceInput())).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("apiPrefix 归一化与 endpoint 拼接", () => {
    expect(opikApiPrefix(mkConfig({ apiPrefix: "" }))).toBe("/v1/private");
    expect(opikApiPrefix(mkConfig({ apiPrefix: "api/v1/private/" }))).toBe("/api/v1/private");
    expect(opikEndpoint(mkConfig(), "/traces")).toBe(`${BASE}/v1/private/traces`);
    expect(opikEndpoint(mkConfig({ apiPrefix: "/api/v1/private" }), "/traces/abc"))
      .toBe(`${BASE}/api/v1/private/traces/abc`);
    expect(opikEndpoint(mkConfig({ url: `${BASE}/` }), "traces")).toBe(`${BASE}/v1/private/traces`);
  });

  it("创建 trace：POST /v1/private/traces，metadata 原样透传，无 fork 时返回空串", async () => {
    const id = opikCreateTrace(
      mkConfig(),
      traceInput({ metadata: { agent_source: "codex", session_key: "s1" } }),
    );
    expect(id).toBe("");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/private/traces`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.id).toBe("trace-1");
    expect(body.project_name).toBe("usr-key");
    expect(body.input).toEqual({ messages: [] });
    expect(body.metadata).toEqual({ agent_source: "codex", session_key: "s1" });
  });

  it("fork trace：独立 UUID、request_log 脱敏、tags 只留 keyId/modelId", async () => {
    const forkId = opikCreateTrace(
      mkConfig({ stripRequestLogContent: true, requestLogEnabled: true }),
      traceInput({
        forkProjectName: "request_log",
        forkMetadata: { keyId: "k1", modelId: "glm-4.5", stream: true },
      }),
    );
    await flush();
    expect(forkId).not.toBe("");
    expect(forkId).toMatch(/^[0-9a-f]{8}-/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/private/traces/batch`);
    const body = JSON.parse(String(init.body)) as { traces: Array<Record<string, unknown>> };
    expect(body.traces).toHaveLength(2);
    const forkBody = body.traces.find((t) => t.project_name === "request_log")!;
    expect(forkBody.id).toBe(forkId);
    expect(forkBody.input).toEqual({ messages: "[stripped]" });
    expect(forkBody.tags).toEqual(["keyId:k1", "modelId:glm-4.5"]);
    expect((forkBody.metadata as Record<string, unknown>).forkTraceId).toBe(forkId);
  });

  it("连续 create trace 自动合并成 /traces/batch", async () => {
    opikCreateTrace(mkConfig(), traceInput({ traceId: "trace-a", metadata: {} }));
    opikCreateTrace(mkConfig(), traceInput({ traceId: "trace-b", metadata: {} }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/private/traces/batch`);
    const body = JSON.parse(String(init.body)) as { traces: Array<Record<string, unknown>> };
    expect(body.traces.map((t) => t.id)).toEqual(["trace-a", "trace-b"]);
  });

  it("FIFO：create trace → update trace → span 按顺序发送，避免先改后建", async () => {
    const cfg = mkConfig();
    opikCreateTrace(cfg, traceInput());
    opikUpdateTrace(cfg, {
      traceId: "trace-1",
      projectName: "usr-key",
      endTime: "2026-09-06T00:00:01Z",
      output: [{ role: "assistant" }],
      usage: { total_tokens: 3 },
    });
    opikCreateLlmSpan(cfg, {
      traceId: "trace-1",
      projectName: "usr-key",
      name: "glm-4.5",
      startTime: "2026-09-06T00:00:00Z",
      endTime: "2026-09-06T00:00:01Z",
      inputMessages: [],
      outputMessage: null,
      model: "glm-4.5",
      usage: {},
    });
    await flush();
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toBe(`${BASE}/v1/private/traces`);
    expect(calls[0][1].method).toBe("POST");
    expect(calls[1][0]).toBe(`${BASE}/v1/private/traces/trace-1`);
    expect(calls[1][1].method).toBe("PATCH");
    expect(calls[2][0]).toBe(`${BASE}/v1/private/spans`);
    expect(calls[2][1].method).toBe("POST");
  });

  it("batch.enabled=false 退化为逐条立即上报（不拼 /batch）", async () => {
    const cfg = mkConfig({
      batch: { enabled: false, maxBatchSize: 20, flushIntervalMs: 1000 },
    });
    opikCreateTrace(cfg, traceInput({ traceId: "trace-a", metadata: {} }));
    opikCreateTrace(cfg, traceInput({ traceId: "trace-b", metadata: {} }));
    await flush();
    const urls = (fetchMock.mock.calls as [string, RequestInit][]).map(([u]) => u);
    expect(urls).toEqual([
      `${BASE}/v1/private/traces`,
      `${BASE}/v1/private/traces`,
    ]);
  });

  it("batch 端点 404（老版本 Opik）时逐条回退，不丢数据", async () => {
    fetchMock
      .mockResolvedValueOnce(httpResponse(404))
      .mockResolvedValue(okResponse());
    const cfg = mkConfig({ batch: { enabled: true, maxBatchSize: 2, flushIntervalMs: 1000 } });
    opikCreateTrace(cfg, traceInput({ traceId: "trace-a", metadata: {} }));
    opikCreateTrace(cfg, traceInput({ traceId: "trace-b", metadata: {} }));
    await flush();
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toBe(`${BASE}/v1/private/traces/batch`);
    expect(calls[1][0]).toBe(`${BASE}/v1/private/traces`);
    expect(calls[2][0]).toBe(`${BASE}/v1/private/traces`);
  });

  it("队列满 maxBatchSize 立即刷出", async () => {
    const cfg = mkConfig({ batch: { enabled: true, maxBatchSize: 2, flushIntervalMs: 1000 } });
    opikCreateTrace(cfg, traceInput({ traceId: "trace-a", metadata: {} }));
    opikCreateTrace(cfg, traceInput({ traceId: "trace-b", metadata: {} }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/private/traces/batch`);
    const body = JSON.parse(String(init.body)) as { traces: Array<Record<string, unknown>> };
    expect(body.traces.map((t) => t.id)).toEqual(["trace-a", "trace-b"]);
  });

  it("requestLogEnabled 默认关闭时不 fork，只发主项目一条", async () => {
    const forkId = opikCreateTrace(
      mkConfig(),
      traceInput({
        forkProjectName: "request_log",
        forkMetadata: { keyId: "k1", modelId: "glm-4.5", stream: true },
      }),
    );
    await flush();
    expect(forkId).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/private/traces`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.project_name).toBe("usr-key");
    expect(body.project_name).not.toBe("request_log");
  });

  it("update trace：PATCH 到 /traces/{id}，usage 原样保留", async () => {
    opikUpdateTrace(mkConfig(), {
      traceId: "trace-9",
      projectName: "usr-key",
      endTime: "2026-09-06T00:00:00Z",
      output: [{ role: "assistant" }],
      usage: { prompt_tokens: 10, total_tokens: 12, credit: 0.43 },
    });
    await flush();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/private/traces/trace-9`);
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.workspace_name).toBe("default");
    expect(body.usage).toEqual({ prompt_tokens: 10, total_tokens: 12, credit: 0.43 });
  });

  it("fork trace 收尾：strip=false 带 output；strip=true 仍写 end_time 但 output 置空", async () => {
    const output = [{ role: "assistant", content: "secret answer" }];
    opikUpdateTraceFork(mkConfig(), {
      traceId: "fork-1",
      endTime: "2026-09-06T00:00:02Z",
      output,
      usage: { total_tokens: 5 },
    });
    await flush();
    const first = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
    expect(first.project_name).toBe("request_log");
    expect(first.output).toEqual(output);

    fetchMock.mockClear();
    opikUpdateTraceFork(mkConfig({ stripRequestLogContent: true }), {
      traceId: "fork-2",
      endTime: "2026-09-06T00:00:02Z",
      output,
      usage: { total_tokens: 5 },
    });
    await flush();
    const second = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
    expect(second.project_name).toBe("request_log");
    expect(second.end_time).toBeDefined();
    expect(second.output).toEqual([]);
  });

  it("LLM span：usage 扁平化、credit → credit_x100、metadata 透传", async () => {
    opikCreateLlmSpan(mkConfig(), {
      traceId: "trace-1",
      projectName: "usr-key",
      name: "glm-4.5",
      startTime: "2026-09-06T00:00:00Z",
      endTime: "2026-09-06T00:00:02Z",
      inputMessages: [{ role: "user" }],
      outputMessage: { role: "assistant", content: "hi" },
      model: "glm-4.5",
      usage: { input_tokens: 11, output_tokens: 2, credit: 0.43 },
      metadata: { turn_seq: 2 },
    });
    await flush();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/private/spans`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.type).toBe("llm");
    expect(body.trace_id).toBe("trace-1");
    expect(body.usage).toEqual({ input_tokens: 11, output_tokens: 2, credit_x100: 43 });
    expect(body.metadata).toEqual({ turn_seq: 2 });
  });

  it("fork span：strip 时不带 input/output，metadata 保留原始 credit", async () => {
    opikCreateLlmSpan(
      mkConfig({ stripRequestLogContent: true, requestLogEnabled: true }),
      {
        traceId: "trace-1",
        projectName: "usr-key",
        name: "glm-4.5",
        startTime: "2026-09-06T00:00:00Z",
        endTime: "2026-09-06T00:00:02Z",
        inputMessages: [{ role: "user", content: "secret" }],
        outputMessage: { role: "assistant", content: "answer" },
        model: "glm-4.5",
        usage: { credit: 0.43 },
        forkProjectName: "request_log",
        forkTraceId: "fork-1",
        forkMetadata: { keyId: "k1", modelId: "glm-4.5" },
      },
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/private/spans/batch`);
    const body = JSON.parse(String(init.body)) as { spans: Array<Record<string, unknown>> };
    expect(body.spans).toHaveLength(2);
    const forkBody = body.spans.find((s) => s.trace_id === "fork-1")!;
    expect(forkBody.input).toBeUndefined();
    expect(forkBody.output).toBeUndefined();
    expect(forkBody.usage).toEqual({ credit_x100: 43 });
    expect((forkBody.metadata as Record<string, unknown>).credit).toBe(0.43);
    expect(forkBody.tags).toEqual(["keyId:k1", "modelId:glm-4.5"]);
  });

  it("opikReportFailure：关闭 trace + 补 error LLM span（无 fork）", async () => {
    opikReportFailure(mkConfig(), {
      traceId: "trace-1",
      projectName: "usr-key",
      model: "glm-4.5",
      startTime: "2026-09-06T00:00:00Z",
      stage: "upstream",
      status: 502,
      message: "boom upstream",
      inputMessages: [{ role: "user", content: "hi" }],
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [patchCall, spanCall] = fetchMock.mock.calls as [string, RequestInit][];
    expect(patchCall[0]).toBe(`${BASE}/v1/private/traces/trace-1`);
    expect(patchCall[1].method).toBe("PATCH");
    const patchBody = JSON.parse(String(patchCall[1].body)) as Record<string, unknown>;
    expect(patchBody.end_time).toBeDefined();
    expect((patchBody.metadata as Record<string, unknown>).error).toMatchObject({
      stage: "upstream",
      status: 502,
      message: "boom upstream",
    });
    expect(spanCall[0]).toBe(`${BASE}/v1/private/spans`);
    const spanBody = JSON.parse(String(spanCall[1].body)) as Record<string, unknown>;
    expect(spanBody.type).toBe("llm");
    expect(spanBody.trace_id).toBe("trace-1");
    expect(spanBody.tags).toContain("error");
    const output = spanBody.output as Array<Record<string, unknown>>;
    expect(String(output[0].content)).toContain("boom upstream");
  });

  it("opikReportFailure：开启 request_log 时 fork trace/span 一并收尾", async () => {
    opikReportFailure(
      mkConfig({ requestLogEnabled: true }),
      {
        traceId: "trace-1",
        projectName: "usr-key",
        model: "glm-4.5",
        startTime: "2026-09-06T00:00:00Z",
        stage: "forward",
        message: "network down",
        forkTraceId: "fork-1",
      },
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const patchUrls = calls.filter(([, init]) => init.method === "PATCH").map(([url]) => url);
    expect(patchUrls).toContain(`${BASE}/v1/private/traces/trace-1`);
    expect(patchUrls).toContain(`${BASE}/v1/private/traces/fork-1`);
    const batchCall = calls.find(([url]) => url === `${BASE}/v1/private/spans/batch`);
    expect(batchCall).toBeDefined();
    const spanBodies = (
      JSON.parse(String(batchCall![1].body)) as { spans: Array<Record<string, unknown>> }
    ).spans;
    expect(spanBodies.some((b) => b.trace_id === "trace-1")).toBe(true);
    expect(spanBodies.some((b) => b.trace_id === "fork-1")).toBe(true);
  });

  it("HTTP 失败不抛错；连续失败触发熔断，恢复后继续上报", async () => {
    fetchMock.mockResolvedValue(failResponse());
    for (let i = 0; i < 5; i += 1) {
      expect(() => opikCreateTrace(mkConfig(), traceInput())).not.toThrow();
      await flush();
    }
    // 第 6 次：熔断打开，直接跳过网络
    opikCreateTrace(mkConfig(), traceInput());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(5);

    resetOpikClientForTests();
    fetchMock.mockResolvedValue(okResponse());
    opikCreateTrace(mkConfig(), traceInput());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("配置非法 timeoutMs 时回落默认超时（信号仍存在）", async () => {
    opikCreateTrace(mkConfig({ timeoutMs: 999999 }), traceInput());
    await flush();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeDefined();
  });
});

describe("opikTurnTag（同一轮提问稳定分组）", () => {
  it("同 sessionKey + turnSeq 产生相同 tag，不同 turn 不同", () => {
    expect(opikTurnTag("wb:user:abc", 2)).toBe(opikTurnTag("wb:user:abc", 2));
    expect(opikTurnTag("wb:user:abc", 2)).not.toBe(opikTurnTag("wb:user:abc", 3));
    expect(opikTurnTag("wb:user:abc", 2)).toMatch(/^turn:[0-9a-f]{16}$/);
  });
});

describe("opikTurnTraceId（同轮提问确定性 traceId）", () => {
  it("同 sessionKey + turnSeq 稳定一致，不同 turn / 会话不同，格式为 UUIDv7", () => {
    const a = opikTurnTraceId("wb:user:abc", 2);
    const b = opikTurnTraceId("wb:user:abc", 2);
    expect(a).toBe(b);
    expect(opikTurnTraceId("wb:user:abc", 2)).not.toBe(opikTurnTraceId("wb:user:abc", 3));
    expect(opikTurnTraceId("wb:user:abc", 2)).not.toBe(opikTurnTraceId("wb:user:def", 2));
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("opikQuestionTag（相同内容问题统计标签，不参与 traceId）", () => {
  it("相同问题同标签、不同问题不同标签、空白无标签", () => {
    expect(opikQuestionTag("  帮我写首诗  ")).toBe(opikQuestionTag("帮我写首诗"));
    expect(opikQuestionTag("帮我  写首诗")).toBe(opikQuestionTag("帮我 写首诗"));
    expect(opikQuestionTag("帮我写首诗")).not.toBe(opikQuestionTag("帮我写散文"));
    expect(opikQuestionTag("")).toBeNull();
    expect(opikQuestionTag("   ")).toBeNull();
    expect(opikQuestionTag("帮我写首诗")).toMatch(/^question:[0-9a-f]{16}$/);
  });
});

function traceInput(
  overrides: Partial<{
    traceId: string;
    metadata: Record<string, unknown>;
    forkProjectName: string;
    forkMetadata: Record<string, unknown>;
  }> = {},
) {
  return {
    traceId: "trace-1",
    projectName: "usr-key",
    name: "glm-4.5 / usr-key",
    startTime: "2026-09-06T00:00:00Z",
    input: { messages: [] },
    ...overrides,
  };
}
