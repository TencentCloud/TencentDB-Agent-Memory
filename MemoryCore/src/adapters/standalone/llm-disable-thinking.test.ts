/**
 * Unit tests for the disableThinking strategy model (#1403, porting #228 to v3).
 *
 * Background: reasoning models spend the output budget on thinking, the JSON
 * content comes back empty/truncated (finishReason=length) and L1 extraction
 * yields nothing. AI SDK's openai-compatible provider does not serialize
 * providerOptions.openai.thinking into the request body, so injection happens
 * at the fetch layer.
 *
 * This branch originally injected only `thinking: {type:"disabled"}`, which is
 * the Anthropic/Kimi dialect. A second deployment (reported on #1403) runs
 * vLLM/SGLang-served Qwen, where that field is ignored and
 * `chat_template_kwargs.enable_thinking=false` is required — so the strategy
 * model merged on `main` in #228 is ported here rather than inventing a
 * second dialect list.
 *
 * These tests pin: three-state precedence, `true` shorthand, per-dialect body
 * rewrites, and the non-chat-request passthrough.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveDisableThinking } from "./llm-runner.js";
import {
  createNoThinkFetch,
  normalizeDisableThinking,
  isValidDisableThinkingStrategy,
  type DisableThinkingStrategy,
} from "../../utils/no-think-fetch.js";

/** 用 stub inner fetch 捕获真正发出的 body。 */
async function captureBody(strategy: DisableThinkingStrategy, body: unknown): Promise<Record<string, unknown>> {
  let captured: RequestInit | undefined;
  const inner = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured = init;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const wrapped = createNoThinkFetch(strategy);
  // 包装器内部调用的是 globalThis.fetch，因此用 spyOn 拦截真实出口
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(inner);
  try {
    await wrapped("https://upstream/v1/chat/completions" as Parameters<typeof fetch>[0], {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(String(captured?.body)) as Record<string, unknown>;
}

describe("resolveDisableThinking — 三态优先级（保留 v3 原语义）", () => {
  it("config 显式值优先", () => {
    expect(resolveDisableThinking({ disableThinking: "vllm" }, "false")).toBe("vllm");
    expect(resolveDisableThinking({ disableThinking: "anthropic" })).toBe("anthropic");
  });

  it("显式 false 压过 env=true（运维可强制关掉）", () => {
    expect(resolveDisableThinking({ disableThinking: false }, "true")).toBe(false);
  });

  it("config 未设置时回落 env，且 true 简写 = vllm（与 #228 一致）", () => {
    expect(resolveDisableThinking({}, "true")).toBe("vllm");
    expect(resolveDisableThinking({}, undefined)).toBe(false);
  });

  it("env 严格匹配 'true'（不把 '1'/'yes'/'TRUE' 当开）", () => {
    for (const v of ["1", "yes", "TRUE", "false", ""]) {
      expect(resolveDisableThinking({}, v), `env=${v}`).toBe(false);
    }
  });
});

describe("normalizeDisableThinking — 配置值归一化", () => {
  it("true → vllm；false/undefined → false", () => {
    expect(normalizeDisableThinking(true)).toBe("vllm");
    expect(normalizeDisableThinking(false)).toBe(false);
    expect(normalizeDisableThinking(undefined)).toBe(false);
  });

  it("合法策略字符串原样通过", () => {
    for (const s of ["vllm", "deepseek", "dashscope", "openai", "anthropic", "kimi", "gemini"] as const) {
      expect(normalizeDisableThinking(s)).toBe(s);
      expect(isValidDisableThinkingStrategy(s)).toBe(true);
    }
  });

  it("未知策略降级为 false（fail-safe：不关思考，而不是瞎猜一种方言）", () => {
    expect(normalizeDisableThinking("nonsense")).toBe(false);
    expect(isValidDisableThinkingStrategy("nonsense")).toBe(false);
  });
});

describe("各方言的 body 改写（#1403 的核心痛点）", () => {
  it("vllm: chat_template_kwargs.enable_thinking=false（Qwen/vLLM 必需）", async () => {
    const out = await captureBody("vllm", { model: "qwen3", messages: [{ role: "user", content: "hi" }] });
    expect(out.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(out.thinking).toBeUndefined();
  });

  it("vllm: 合并已有 chat_template_kwargs，不整块覆盖", async () => {
    const out = await captureBody("vllm", {
      model: "qwen3",
      messages: [],
      chat_template_kwargs: { custom_flag: true },
    });
    expect(out.chat_template_kwargs).toEqual({ custom_flag: true, enable_thinking: false });
  });

  it("deepseek / dashscope: 顶层 enable_thinking=false", async () => {
    const ds = await captureBody("deepseek", { model: "deepseek-v4", messages: [] });
    expect(ds.enable_thinking).toBe(false);
    const dash = await captureBody("dashscope", { model: "qwen", messages: [] });
    expect(dash.enable_thinking).toBe(false);
  });

  it("anthropic / kimi: thinking.type=disabled（原 v3 行为，未回退）", async () => {
    for (const s of ["anthropic", "kimi"] as const) {
      const out = await captureBody(s, { model: "m", messages: [] });
      expect(out.thinking, s).toEqual({ type: "disabled" });
    }
  });

  it("openai: reasoning_effort=low（o 系无法完全关闭，退而求其次）", async () => {
    const out = await captureBody("openai", { model: "o3", messages: [] });
    expect(out.reasoning_effort).toBe("low");
  });

  it("gemini: thinking_config.thinking_budget=0", async () => {
    const out = await captureBody("gemini", { model: "gemini", messages: [] });
    expect(out.thinking_config).toEqual({ thinking_budget: 0 });
  });

  it("策略=false → 直接返回原生 fetch，不做任何包装（零开销、不注入）", () => {
    // 契约本身就是「不包装」，所以断言同一性而不是去拦截一个不存在的包装层。
    expect(createNoThinkFetch(false)).toBe(globalThis.fetch);
  });
});

describe("非 chat 请求不动（embeddings 等）", () => {
  it("body 里没有 messages 数组 → 原样转发", async () => {
    const body = { model: "text-embedding-3-small", input: ["a", "b"] };
    const out = await captureBody("vllm", body);
    expect(out).toEqual(body);
  });

  it("非 JSON 字符串 body → 原样转发不抛错", async () => {
    let seen: string | undefined;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (_u: unknown, init?: RequestInit) => {
      seen = String(init?.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    try {
      await createNoThinkFetch("vllm")("https://upstream/v1/chat/completions" as Parameters<typeof fetch>[0], {
        method: "POST",
        body: "not-json",
      });
    } finally {
      spy.mockRestore();
    }
    expect(seen).toBe("not-json");
  });
});
