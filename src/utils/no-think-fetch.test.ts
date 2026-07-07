import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createNoThinkFetch,
  isValidDisableThinkingStrategy,
  normalizeDisableThinking,
  type DisableThinkingStrategy,
} from "./no-think-fetch";

/**
 * Capture the (input, init) passed through to the real global fetch so we can
 * assert on the (possibly rewritten) request body. The mock never blindly
 * JSON.parses the body — it just records and returns a stub Response.
 */
function captureFetch() {
  const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch);
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createNoThinkFetch", () => {
  // ─── vllm strategy (original behavior) ────────────────────────────────────

  describe("vllm strategy", () => {
    it("injects chat_template_kwargs.enable_thinking=false into chat bodies", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("vllm");

      await f("https://example/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "qwen3", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(sent.messages).toHaveLength(1);
    });

    it("merges into an existing chat_template_kwargs instead of clobbering it", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("vllm");

      await f("https://example", {
        body: JSON.stringify({ messages: [], chat_template_kwargs: { foo: "bar", enable_thinking: true } }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.chat_template_kwargs).toEqual({ foo: "bar", enable_thinking: false });
    });

    it("leaves embedding requests (input, no messages) untouched", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("vllm");
      const body = JSON.stringify({ model: "bge-m3", input: ["hello"] });

      await f("https://example/v1/embeddings", { body });

      expect(calls[0].init!.body).toBe(body);
      expect(JSON.parse(calls[0].init!.body as string).chat_template_kwargs).toBeUndefined();
    });
  });

  // ─── deepseek strategy ───────────────────────────────────────────────────

  describe("deepseek strategy", () => {
    it("injects top-level enable_thinking: false", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("deepseek");

      await f("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "deepseek-reasoner", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.enable_thinking).toBe(false);
      expect(sent.chat_template_kwargs).toBeUndefined();
      expect(sent.messages).toHaveLength(1);
    });
  });

  // ─── dashscope strategy ─────────────────────────────────────────────────

  describe("dashscope strategy", () => {
    it("injects top-level enable_thinking: false", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("dashscope");

      await f("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "qwen-plus", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.enable_thinking).toBe(false);
      expect(sent.chat_template_kwargs).toBeUndefined();
    });
  });

  // ─── openai strategy ────────────────────────────────────────────────────

  describe("openai strategy", () => {
    it("injects reasoning_effort: low", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("openai");

      await f("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "o3-mini", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.reasoning_effort).toBe("low");
      expect(sent.chat_template_kwargs).toBeUndefined();
      expect(sent.enable_thinking).toBeUndefined();
    });
  });

  // ─── anthropic strategy ─────────────────────────────────────────────────

  describe("anthropic strategy", () => {
    it("injects thinking: { type: disabled }", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("anthropic");

      await f("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.thinking).toEqual({ type: "disabled" });
      expect(sent.chat_template_kwargs).toBeUndefined();
    });
  });

  // ─── kimi strategy ─────────────────────────────────────────────────────

  describe("kimi strategy", () => {
    it("injects thinking: { type: disabled }", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("kimi");

      await f("https://api.moonshot.cn/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "kimi-k2.6", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.thinking).toEqual({ type: "disabled" });
      expect(sent.chat_template_kwargs).toBeUndefined();
      expect(sent.enable_thinking).toBeUndefined();
    });
  });

  // ─── gemini strategy ────────────────────────────────────────────────────

  describe("gemini strategy", () => {
    it("injects thinking_config: { thinking_budget: 0 }", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("gemini");

      await f("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.thinking_config).toEqual({ thinking_budget: 0 });
      expect(sent.chat_template_kwargs).toBeUndefined();
    });
  });

  // ─── strategy === false (passthrough) ───────────────────────────────────

  describe("false strategy", () => {
    it("returns globalThis.fetch directly", () => {
      const f = createNoThinkFetch(false);
      expect(f).toBe(globalThis.fetch);
    });

    it("default parameter returns globalThis.fetch", () => {
      const f = createNoThinkFetch();
      expect(f).toBe(globalThis.fetch);
    });
  });

  // ─── Common behavior across all strategies ──────────────────────────────

  describe("common behavior", () => {
    it("forwards a non-JSON string body unchanged", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("vllm");

      await f("https://example", { body: "not-json" });

      expect(calls[0].init!.body).toBe("not-json");
    });

    it("forwards requests with no init and with a non-string body unchanged", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("deepseek");

      await f("https://example");
      expect(calls[0].init).toBeUndefined();

      const blob = new Uint8Array([1, 2, 3]);
      await f("https://example", { body: blob });
      expect(calls[1].init!.body).toBe(blob);
    });
  });
});

// ─── Validation helpers ─────────────────────────────────────────────────────

describe("isValidDisableThinkingStrategy", () => {
  it("returns true for all valid strategies", () => {
    const valid: DisableThinkingStrategy[] = [false, "vllm", "deepseek", "dashscope", "openai", "anthropic", "kimi", "gemini"];
    for (const v of valid) {
      expect(isValidDisableThinkingStrategy(v)).toBe(true);
    }
  });

  it("returns false for invalid values", () => {
    const invalid = [true, "invalid", "sglang", "VLLM", 0, null, undefined, "", "true"];
    for (const v of invalid) {
      expect(isValidDisableThinkingStrategy(v)).toBe(false);
    }
  });
});

describe("normalizeDisableThinking", () => {
  it("maps true to vllm (shorthand)", () => {
    expect(normalizeDisableThinking(true)).toBe("vllm");
  });

  it("maps false to false", () => {
    expect(normalizeDisableThinking(false)).toBe(false);
  });

  it("maps undefined to false", () => {
    expect(normalizeDisableThinking(undefined)).toBe(false);
  });

  it("passes through valid strategy strings", () => {
    expect(normalizeDisableThinking("vllm")).toBe("vllm");
    expect(normalizeDisableThinking("deepseek")).toBe("deepseek");
    expect(normalizeDisableThinking("dashscope")).toBe("dashscope");
    expect(normalizeDisableThinking("openai")).toBe("openai");
    expect(normalizeDisableThinking("anthropic")).toBe("anthropic");
    expect(normalizeDisableThinking("kimi")).toBe("kimi");
    expect(normalizeDisableThinking("gemini")).toBe("gemini");
  });

  it("warns and returns false for unknown strategies", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeDisableThinking("unknown_strategy")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown disableThinking strategy "unknown_strategy"'),
    );
    warnSpy.mockRestore();
  });
});
