import { afterEach, describe, expect, it, vi } from "vitest";

import { createThinkingDisabledFetch } from "./llm-runner.js";

/**
 * createThinkingDisabledFetch() must inject `thinking: { type: "disabled" }`
 * into every chat-completions request body and leave everything else
 * untouched. Some reasoning models otherwise spend the whole max_tokens
 * budget on reasoning tokens and truncate structured (JSON) extraction
 * output to nothing.
 */
describe("createThinkingDisabledFetch", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function captureFetch() {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return calls;
  }

  it("injects thinking={type:disabled} into chat-completions bodies", async () => {
    const calls = captureFetch();
    const wrapped = createThinkingDisabledFetch();

    await wrapped("http://localhost:1/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "some-reasoning-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8192,
      }),
    });

    expect(calls).toHaveLength(1);
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.thinking).toEqual({ type: "disabled" });
    // Original fields survive the injection.
    expect(sent.messages).toHaveLength(1);
    expect(sent.max_tokens).toBe(8192);
  });

  it("does not mutate init when the body is not a chat request", async () => {
    const calls = captureFetch();
    const wrapped = createThinkingDisabledFetch();

    const body = JSON.stringify({ model: "m", prompt: "x" });
    await wrapped("http://localhost:1/v1/completions", { method: "POST", body });

    expect(calls).toHaveLength(1);
    expect(String(calls[0].init?.body)).toBe(body);
  });

  it("passes non-JSON bodies through untouched", async () => {
    const calls = captureFetch();
    const wrapped = createThinkingDisabledFetch();

    await wrapped("http://localhost:1/raw", { method: "POST", body: "not-json{{" });

    expect(calls).toHaveLength(1);
    expect(String(calls[0].init?.body)).toBe("not-json{{");
  });

  it("passes requests without a body through untouched", async () => {
    const calls = captureFetch();
    const wrapped = createThinkingDisabledFetch();

    await wrapped("http://localhost:1/health");

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.body).toBeUndefined();
  });
});
