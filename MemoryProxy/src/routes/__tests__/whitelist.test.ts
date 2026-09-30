import { describe, expect, it } from "vitest";
import {
  matchWhitelistEndpoint,
  normalizeWhitelistRequestPath,
} from "../whitelist.js";
import { joinUrl } from "../../guard-adapter.js";

describe("AGENT_PREFIX_RE is agent-agnostic (reserved-word exclusion)", () => {
  it("keeps bare /v1/* endpoints intact", () => {
    expect(normalizeWhitelistRequestPath("/v1/models")).toBe("/v1/models");
    expect(normalizeWhitelistRequestPath("/v1/messages")).toBe("/v1/messages");
    expect(normalizeWhitelistRequestPath("/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(normalizeWhitelistRequestPath("/v1/embeddings")).toBe("/v1/embeddings");
  });

  it("keeps /responses codex bare endpoint intact", () => {
    expect(normalizeWhitelistRequestPath("/responses")).toBe("/responses");
  });

  it("keeps non-agent first segments intact (skill-bridge / memory-bridge)", () => {
    expect(normalizeWhitelistRequestPath("/skill-bridge/v3/skill/search")).toBe("/skill-bridge/v3/skill/search");
    expect(normalizeWhitelistRequestPath("/memory-bridge/v3/memory/search")).toBe("/memory-bridge/v3/memory/search");
  });

  it("strips any agent prefix for auxiliary endpoints (no hardcoded agent list)", () => {
    const agents = [
      "claude-code",
      "codebuddy",
      "codex",
      "cursor",
      "anthropic",
      "openai",
      "workbuddy",
      "dsh",
      "opencode",
      "pi",
      "hermes",
      "openclaw",
      "some-future-agent",
    ];
    for (const agent of agents) {
      expect(
        matchWhitelistEndpoint(`/${agent}/mem001/v1/embeddings`)?.upstreamEndpoint,
        `agent=${agent}`,
      ).toBe("/embeddings");
      expect(
        normalizeWhitelistRequestPath(`/${agent}/mem001/v1/embeddings`),
        `agent=${agent}`,
      ).toBe("/v1/embeddings");
    }
  });
});

describe("models endpoint is not in the whitelist (handled independently)", () => {
  it("does not claim a whitelist entry for /v1/models or /models", () => {
    expect(matchWhitelistEndpoint("/v1/models")).toBeNull();
    expect(matchWhitelistEndpoint("/dsh/default/models")).toBeNull();
  });

  it("joinUrl still falls back to /chat/completions for models (unused by models handler)", () => {
    expect(joinUrl("https://upstream.example.com/v1", "/v1/models")).toBe(
      "https://upstream.example.com/v1/chat/completions",
    );
  });
});

describe("joinUrl for non-models endpoints is unaffected", () => {
  it("maps /v1/chat/completions correctly", () => {
    expect(joinUrl("https://upstream.example.com/v1", "/v1/chat/completions")).toBe(
      "https://upstream.example.com/v1/chat/completions",
    );
  });
});
