/**
 * 转发阶段用例：forwardStage(ctx, { retry, auth }) 把 4 个 handler 的转发差异
 * 收敛到参数上，行为与各 handler 原实现对齐。
 *
 * 覆盖：
 *   - raw 模式（chat/anthropic）：鉴权头、retry（模型覆盖差异）、超时 signal；
 *   - shape 模式（codex/workbuddy）：per-agent URL、协议翻译、4xx 差异、tap。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { forwardStage } from "../stages/forward.js";
import type { ForwardStageOptions } from "../stages/forward.js";
import type { ProxyConfig } from "../types.js";
import type { createPipeline } from "../logger.js";

function makeCtx(
  path: string,
  config: Partial<ProxyConfig> = {},
): { c: any; config: ProxyConfig } {
  const c = {
    req: {
      raw: {
        headers: new Headers({
          "x-request-id": "req-1",
          authorization: "Bearer sk-client",
          "content-type": "application/json",
        }),
      },
      header: (n: string) =>
        n === "authorization" || n === "Authorization" ? "Bearer sk-client" : null,
      path,
    },
    json: (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  } as never;
  const cfg = {
    upstream: {
      url: "https://upstream.example.com",
      apiKey: "sk-global",
      agents: {},
    },
    ...config,
  } as ProxyConfig;
  return { c, config: cfg };
}

function makePipe(): ReturnType<typeof createPipeline> {
  return {
    forwardStart: vi.fn(),
    forwardDone: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as ReturnType<typeof createPipeline>;
}

function makeTarget(over: Record<string, unknown> = {}): ForwardStageOptions["target"] {
  return {
    url: "https://primary.example.com/v1/chat/completions",
    model: "gpt-x",
    authHeaders: null,
    bodyOverrides: null,
    retryTarget: null,
    logLine: "",
    logLineExtra: "",
    tags: [],
    analyzerTrace: null,
    logMeta: {},
    turnSeq: 0,
    routedFrom: "",
    ...over,
  } as ForwardStageOptions["target"];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("forwardStage raw 模式（chat）", () => {
  it("构建鉴权头并转发（effectiveApiKey → authorization Bearer）", async () => {
    const { c, config } = makeCtx("/claude-code/default/v1/chat/completions");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await forwardStage({ c, config }, {
      protocol: "chat",
      pipe: makePipe(),
      target: makeTarget(),
      body: { messages: [{ role: "user", content: "hi" }], model: "gpt-x" },
      auth: { apiKey: "sk-server", sessionKey: "sess-1" },
      timeoutMs: 600_000,
    });

    expect(result.retried).toBe(false);
    expect(result.effectiveModel).toBe("gpt-x");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://primary.example.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-server");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-vertex-ai-session-id"]).toBe("sess-1");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.model).toBe("gpt-x");
  });

  it("chatToAnthropic 时改用 x-api-key + anthropic-version", async () => {
    const { c, config } = makeCtx("/workbuddy/default/v1/chat/completions", {
      upstream: {
        url: "https://upstream.example.com",
        apiKey: "sk-global",
        agents: {
          workbuddy: { chatToAnthropic: true },
        },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await forwardStage({ c, config }, {
      protocol: "chat",
      pipe: makePipe(),
      target: makeTarget(),
      body: { messages: [] },
      auth: { apiKey: "sk-server" },
    });

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-server");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("上游 4xx 时按 retryTarget 重试，chat 重试体覆盖 model", async () => {
    const { c, config } = makeCtx("/claude-code/default/v1/chat/completions");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await forwardStage({ c, config }, {
      protocol: "chat",
      pipe: makePipe(),
      target: makeTarget({
        retryTarget: { url: "https://retry.example.com/v1/chat/completions", model: "gpt-y", authHeaders: null },
      }),
      body: { messages: [{ role: "user", content: "hi" }], model: "gpt-x" },
      auth: { apiKey: "sk-server", sessionKey: "sess-1" },
      retry: {
        target: { url: "https://retry.example.com/v1/chat/completions", model: "gpt-y", authHeaders: null },
        originalBody: { messages: [{ role: "user", content: "hi" }], model: "gpt-x" },
        originalHeaders: { "x-request-id": "req-1" },
        bodyModelOverride: true,
      },
    });

    expect(result.retried).toBe(true);
    expect(result.effectiveModel).toBe("gpt-y");
    const retryInit = (fetchMock.mock.calls[1] as [string, RequestInit])[1];
    const retryBody = JSON.parse(String(retryInit.body)) as Record<string, unknown>;
    expect(retryBody.model).toBe("gpt-y");
    const retryHeaders = retryInit.headers as Record<string, string>;
    expect(retryHeaders["x-vertex-ai-session-id"]).toBe("sess-1");
    expect(retryHeaders["content-type"]).toBe("application/json");
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe("https://retry.example.com/v1/chat/completions");
  });
});

describe("forwardStage raw 模式（anthropic）", () => {
  it("effectiveApiKey 直通 → x-api-key；重试体不覆盖 model", async () => {
    const { c, config } = makeCtx("/claude-code/default/v1/messages");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await forwardStage({ c, config }, {
      protocol: "anthropic",
      pipe: makePipe(),
      target: makeTarget({
        url: "https://primary.example.com/v1/messages",
        model: "claude-x",
        retryTarget: { url: "https://retry.example.com/v1/messages", model: "claude-y", authHeaders: null },
      }),
      body: { messages: [{ role: "user", content: "hi" }], model: "claude-x" },
      auth: { apiKey: "sk-server", sessionKey: "sess-2" },
      retry: {
        target: { url: "https://retry.example.com/v1/messages", model: "claude-y", authHeaders: null },
        originalBody: { messages: [{ role: "user", content: "hi" }], model: "claude-x" },
        originalHeaders: { "x-request-id": "req-2" },
        bodyModelOverride: false,
      },
    });

    const firstHeaders = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(firstHeaders["x-api-key"]).toBe("sk-server");
    expect(firstHeaders["authorization"]).toBeUndefined();
    expect(result.retried).toBe(true);
    expect(result.effectiveModel).toBe("claude-y");
    const retryBody = JSON.parse(
      String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(retryBody.model).toBe("claude-x"); // anthropic 重试不发 model 覆盖
  });
});

describe("forwardStage shape 模式（codex）", () => {
  const codexCfg = {
    upstream: {
      url: "https://upstream.example.com",
      apiKey: "sk-global",
      agents: {
        codex: { url: "https://codex-up.example.com", apiKey: "sk-agent", chatCompletions: true },
      },
    },
  };

  it("per-agent URL + chatCompat 翻译 body + SSE 塑形 + tap", async () => {
    const { c, config } = makeCtx("/codex/default/v1/responses", codexCfg);
    const consume = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await forwardStage({ c, config }, {
      protocol: "responses",
      pipe: makePipe(),
      agent: "codex",
      body: {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        model: "m",
        max_output_tokens: 999_999,
      },
      chatCompletions: true,
      setContentType: true,
      shape: {
        enabled: true,
        modelId: "m",
        errorBody: "read",
        tap: { enabled: true, consume },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://codex-up.example.com/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-agent");
    expect(headers["content-type"]).toBe("application/json");
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Array.isArray(sent.messages)).toBe(true); // responses → chat 翻译
    expect(sent.max_tokens).toBe(32_768); // 智谱上限截断（翻译后落到 max_tokens）
    expect(result.resp.status).toBe(200);
    expect(result.resp.headers.get("content-type")).toBe("text/event-stream");
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("errorBody=read：4xx 读 body 上报后原样返回", async () => {
    const { c, config } = makeCtx("/codex/default/v1/responses", codexCfg);
    const onErrorStatus = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "bad" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await forwardStage({ c, config }, {
      protocol: "responses",
      pipe: makePipe(),
      agent: "codex",
      body: { input: [], model: "m" },
      setContentType: true,
      shape: { enabled: true, modelId: "m", errorBody: "read", onErrorStatus },
    });

    expect(onErrorStatus).toHaveBeenCalledWith(400, JSON.stringify({ error: "bad" }), expect.objectContaining({ upstreamUrl: expect.any(String) }));
    expect(result.resp.status).toBe(400);
    expect(await result.resp.text()).toBe(JSON.stringify({ error: "bad" }));
  });

  it("fetch 失败走 onFetchError（不抛上游异常）", async () => {
    const { c, config } = makeCtx("/codex/default/v1/responses", codexCfg);
    const onFetchError = vi.fn().mockResolvedValue(new Response("502", { status: 502 }));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("ECONNRESET")));

    const result = await forwardStage({ c, config }, {
      protocol: "responses",
      pipe: makePipe(),
      agent: "codex",
      body: { input: [], model: "m" },
      setContentType: true,
      shape: { enabled: true, modelId: "m", errorBody: "read", onFetchError },
    });

    expect(onFetchError).toHaveBeenCalledTimes(1);
    expect(result.resp.status).toBe(502);
  });
});

describe("forwardStage shape 模式（workbuddy）", () => {
  it("path 去前缀 + errorBody=passthrough：4xx 只上报并透传", async () => {
    const { c, config } = makeCtx("/workbuddy/default/v1/responses", {
      upstream: {
        url: "https://upstream.example.com",
        apiKey: "sk-global",
        agents: {},
      },
    });
    const onErrorStatus = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("rate limited", {
          status: 429,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    const result = await forwardStage({ c, config }, {
      protocol: "responses",
      pipe: makePipe(),
      agent: "workbuddy",
      body: { input: [{ type: "message", role: "user", content: [] }], model: "m" },
      path: c.req.path.replace(/^\/workbuddy\/[^/]+/, ""),
      shape: {
        enabled: true,
        modelId: "m",
        errorBody: "passthrough",
        onErrorStatus,
      },
    });

    const url = (vi.mocked(fetch).mock.calls[0] as [string])[0];
    expect(url).toBe("https://upstream.example.com/responses");
    expect(url).not.toContain("/workbuddy/");
    expect(onErrorStatus).toHaveBeenCalledWith(429, null, expect.objectContaining({ contentType: "text/plain" }));
    expect(result.resp.status).toBe(429);
    expect(await result.resp.text()).toBe("rate limited");
  });

  it("chatCompletions 非 SSE：chat JSON → Responses JSON", async () => {
    const { c, config } = makeCtx("/workbuddy/default/v1/responses", {
      upstream: {
        url: "https://upstream.example.com",
        apiKey: "sk-global",
        agents: { workbuddy: { chatCompletions: true } },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await forwardStage({ c, config }, {
      protocol: "responses",
      pipe: makePipe(),
      agent: "workbuddy",
      body: { input: [{ type: "message", role: "user", content: [] }], model: "m" },
      path: "/v1/responses",
      chatCompletions: true,
      shape: { enabled: true, modelId: "m", errorBody: "passthrough" },
    });

    expect(result.resp.status).toBe(200);
    const json = (await result.resp.json()) as Record<string, unknown>;
    expect(Array.isArray(json.output)).toBe(true);
  });
});
