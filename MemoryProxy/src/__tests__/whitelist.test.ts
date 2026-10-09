/**
 * Tests for #825 — the whitelist upstream endpoint for Anthropic paths must
 * keep the /v1/ segment (dropping it made forwarded calls hit /messages → 404).
 */

import { describe, expect, it } from "vitest";
import { matchWhitelistEndpoint } from "../routes/whitelist.js";

describe("matchWhitelistEndpoint (#825)", () => {
  it("keeps /v1/ for anthropic /messages after stripping the agent+space prefix", () => {
    const ep = matchWhitelistEndpoint("/claude-code/default/v1/messages");
    expect(ep?.protocol).toBe("anthropic");
    expect(ep?.upstreamEndpoint).toBe("/v1/messages");
  });

  it("keeps /v1/ regardless of agent prefix form", () => {
    expect(matchWhitelistEndpoint("/claude-code/v1/messages")?.upstreamEndpoint).toBe("/v1/messages");
    expect(matchWhitelistEndpoint("/codebuddy/space-1/v1/messages")?.upstreamEndpoint).toBe("/v1/messages");
  });

  it("keeps /v1/ for anthropic count_tokens", () => {
    expect(matchWhitelistEndpoint("/claude-code/default/v1/messages/count_tokens")?.upstreamEndpoint)
      .toBe("/v1/messages/count_tokens");
  });

  it("keeps openai chat completions without a duplicated v1", () => {
    // OpenAI-compatible upstreams put /v1 in their base URL; forwarding
    // /chat/completions is correct and must stay unchanged.
    expect(matchWhitelistEndpoint("/v1/chat/completions")?.upstreamEndpoint).toBe("/chat/completions");
  });
});
