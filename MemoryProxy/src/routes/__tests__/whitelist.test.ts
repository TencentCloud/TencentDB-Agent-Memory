import { describe, expect, it } from "vitest";
import {
  matchWhitelistEndpoint,
  normalizeWhitelistRequestPath,
} from "../whitelist.js";
import { joinUrl } from "../../guard-adapter.js";

describe("matchWhitelistEndpoint /v1/models", () => {
  it("matches the bare /v1/models path", () => {
    const entry = matchWhitelistEndpoint("/v1/models");
    expect(entry).not.toBeNull();
    expect(entry?.pathSuffix).toBe("/v1/models");
    expect(entry?.upstreamEndpoint).toBe("/models");
    expect(entry?.protocol).toBe("openai");
    expect(entry?.isPrimary).toBe(false);
  });

  it("matches the /proxy/<spaceId>/v1/models path", () => {
    const entry = matchWhitelistEndpoint("/proxy/mem-example001/v1/models");
    expect(entry?.pathSuffix).toBe("/v1/models");
    expect(entry?.upstreamEndpoint).toBe("/models");
  });

  it("matches every supported agent-prefixed path", () => {
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
    ];
    for (const agent of agents) {
      const entry = matchWhitelistEndpoint(`/${agent}/mem-example001/v1/models`);
      expect(entry?.upstreamEndpoint, `agent=${agent}`).toBe("/models");
    }
  });

  it("matches any future/unknown agent-prefixed path (reserved-word exclusion)", () => {
    expect(matchWhitelistEndpoint("/future-agent/mem001/v1/models")?.upstreamEndpoint).toBe("/models");
    expect(matchWhitelistEndpoint("/my-custom-agent/v1/models")?.upstreamEndpoint).toBe("/models");
  });
});

describe("normalizeWhitelistRequestPath does not mis-strip reserved paths", () => {
  it("keeps bare /v1/* endpoints intact", () => {
    expect(normalizeWhitelistRequestPath("/v1/models")).toBe("/v1/models");
    expect(normalizeWhitelistRequestPath("/v1/messages")).toBe("/v1/messages");
    expect(normalizeWhitelistRequestPath("/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(normalizeWhitelistRequestPath("/v1/embeddings")).toBe("/v1/embeddings");
  });

  it("keeps /responses codex bare endpoint intact", () => {
    expect(normalizeWhitelistRequestPath("/responses")).toBe("/responses");
  });

  it("keeps non-agent first segments intact (skill-bridge / memory-bridge / proxy)", () => {
    expect(normalizeWhitelistRequestPath("/skill-bridge/v3/skill/search")).toBe("/skill-bridge/v3/skill/search");
    expect(normalizeWhitelistRequestPath("/memory-bridge/v3/memory/search")).toBe("/memory-bridge/v3/memory/search");
  });

  it("normalizes agent-prefixed models paths to /v1/models", () => {
    expect(normalizeWhitelistRequestPath("/proxy/mem001/v1/models")).toBe("/v1/models");
    expect(normalizeWhitelistRequestPath("/codebuddy/mem001/v1/models")).toBe("/v1/models");
    expect(normalizeWhitelistRequestPath("/opencode/v1/models")).toBe("/v1/models");
  });
});

describe("joinUrl /v1/models", () => {
  it("maps /v1/models to upstream /models (not the /chat/completions fallback)", () => {
    expect(joinUrl("https://upstream.example.com/v1", "/v1/models")).toBe(
      "https://upstream.example.com/v1/models",
    );
  });

  it("maps the prefixed forms to the same upstream /models endpoint", () => {
    expect(joinUrl("https://upstream.example.com/v1", "/proxy/mem001/v1/models")).toBe(
      "https://upstream.example.com/v1/models",
    );
    expect(joinUrl("https://upstream.example.com/v1", "/codebuddy/mem001/v1/models")).toBe(
      "https://upstream.example.com/v1/models",
    );
    expect(joinUrl("https://upstream.example.com/v1", "/opencode/mem001/v1/models")).toBe(
      "https://upstream.example.com/v1/models",
    );
  });

  it("strips a trailing slash from the base", () => {
    expect(joinUrl("https://upstream.example.com/v1/", "/v1/models")).toBe(
      "https://upstream.example.com/v1/models",
    );
  });
});
