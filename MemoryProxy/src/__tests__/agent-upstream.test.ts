import { describe, expect, it } from "vitest";
import { resolveAgentUpstreamForProtocol } from "../types.js";

describe("resolveAgentUpstreamForProtocol", () => {
  it("passes a flat entry through unchanged for either protocol", () => {
    const flat = { url: "https://up.example/v1", apiKey: "k" };
    expect(resolveAgentUpstreamForProtocol(flat, "anthropic")).toEqual(flat);
    expect(resolveAgentUpstreamForProtocol(flat, "openai")).toEqual(flat);
  });

  it("prefers the per-protocol sub-entry when present", () => {
    const entry = {
      url: "https://flat.example",
      anthropic: { url: "https://a.example", apiKey: "ka" },
      openai: { url: "https://o.example" },
    };
    expect(resolveAgentUpstreamForProtocol(entry, "anthropic")).toEqual({
      url: "https://a.example",
      apiKey: "ka",
    });
    expect(resolveAgentUpstreamForProtocol(entry, "openai")).toEqual({
      url: "https://o.example",
    });
  });

  it("returns undefined when only the other protocol is configured", () => {
    // 双协议 agent 只配了 openai 子条目 → anthropic 请求走全局默认。
    const entry = { openai: { url: "https://o.example" } };
    expect(resolveAgentUpstreamForProtocol(entry, "anthropic")).toBeUndefined();
    expect(resolveAgentUpstreamForProtocol(entry, "openai")).toEqual({
      url: "https://o.example",
    });
  });

  it("returns undefined for missing entries", () => {
    expect(resolveAgentUpstreamForProtocol(undefined, "anthropic")).toBeUndefined();
    expect(resolveAgentUpstreamForProtocol(null, "openai")).toBeUndefined();
  });
});
