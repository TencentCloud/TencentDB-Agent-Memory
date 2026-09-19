/**
 * Unit tests for the disableThinking request-body rewrite (#1403).
 *
 * Background: reasoning models spend max_output_tokens on thinking, the JSON
 * content comes back empty/truncated (finishReason=length) and L1 extraction
 * yields nothing. AI SDK's openai-compatible provider does not serialize
 * providerOptions.openai.thinking into the request body, so the injection
 * happens at the fetch layer. These tests pin the pure helpers behind that
 * wrapper — including the non-default paths (explicit false overrides env,
 * non-JSON bodies pass through untouched, non-"true" env values stay off).
 */
import { describe, expect, it } from "vitest";
import {
  disabledThinkingFetch,
  injectDisabledThinkingBody,
  resolveDisableThinking,
} from "./llm-runner.js";

describe("resolveDisableThinking — three-state precedence", () => {
  it("explicit config true wins", () => {
    expect(resolveDisableThinking({ disableThinking: true }, "false")).toBe(true);
    expect(resolveDisableThinking({ disableThinking: true })).toBe(true);
  });

  it("explicit config false overrides env=true (operator can force it off)", () => {
    expect(resolveDisableThinking({ disableThinking: false }, "true")).toBe(false);
  });

  it("falls back to env TDAI_DISABLE_THINKING only when config is unset", () => {
    expect(resolveDisableThinking({}, "true")).toBe(true);
    expect(resolveThinkingUnset(undefined)).toBe(false);
  });

  it("env matches strictly on 'true' (no '1'/'yes'/'TRUE' accidents)", () => {
    expect(resolveThinkingUnset("1")).toBe(false);
    expect(resolveThinkingUnset("yes")).toBe(false);
    expect(resolveThinkingUnset("TRUE")).toBe(false);
  });

  function resolveThinkingUnset(envValue?: string): boolean {
    return resolveDisableThinking({}, envValue);
  }
});

describe("injectDisabledThinkingBody — body rewrite", () => {
  it("replaces an existing thinking block with disabled", () => {
    const body = JSON.stringify({
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
    });
    const out = JSON.parse(injectDisabledThinkingBody(body)) as Record<string, unknown>;
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out.model).toBe("glm-5.3-flash");
  });

  it("injects thinking into a body that has none", () => {
    const body = JSON.stringify({
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    const out = JSON.parse(injectDisabledThinkingBody(body)) as Record<string, unknown>;
    expect(out.thinking).toEqual({ type: "disabled" });
    expect((out.messages as unknown[]).length).toBe(1);
  });

  it("returns non-JSON bodies unchanged instead of throwing", () => {
    expect(injectDisabledThinkingBody("not json")).toBe("not json");
    expect(injectDisabledThinkingBody("")).toBe("");
  });
});

describe("disabledThinkingFetch — fetch wrapper", () => {
  it("rewrites string JSON bodies before forwarding", async () => {
    let captured: RequestInit | undefined;
    const inner = async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured = init;
      return new Response("{}", { status: 200 });
    };
    const wrapped = disabledThinkingFetch(inner);
    await wrapped("https://upstream/v1/chat/completions" as Parameters<typeof fetch>[0], {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.3-flash", messages: [] }),
    });
    const sent = JSON.parse(String(captured?.body)) as Record<string, unknown>;
    expect(sent.thinking).toEqual({ type: "disabled" });
    expect(sent.model).toBe("glm-5.3-flash");
  });

  it("passes non-string bodies and undefined init through untouched", async () => {
    const cases: Array<RequestInit | undefined> = [
      undefined,
      { method: "GET" },
      { method: "POST", body: new Uint8Array([1, 2, 3]) },
    ];
    for (const init of cases) {
      let captured: RequestInit | undefined;
      const inner = async (_url: Parameters<typeof fetch>[0], i?: RequestInit) => {
        captured = i;
        return new Response("{}", { status: 200 });
      };
      await disabledThinkingFetch(inner)(
        "https://upstream/v1/chat/completions" as Parameters<typeof fetch>[0],
        init,
      );
      expect(captured).toBe(init);
    }
  });

  it("preserves other init fields (headers) alongside the rewritten body", async () => {
    let captured: RequestInit | undefined;
    const inner = async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured = init;
      return new Response("{}", { status: 200 });
    };
    const wrapped = disabledThinkingFetch(inner);
    await wrapped("https://upstream/v1/chat/completions" as Parameters<typeof fetch>[0], {
      method: "POST",
      headers: { "x-opencode-session": "test-session" },
      body: JSON.stringify({ model: "m" }),
    });
    expect((captured?.headers as Record<string, string>)["x-opencode-session"]).toBe("test-session");
  });
});
