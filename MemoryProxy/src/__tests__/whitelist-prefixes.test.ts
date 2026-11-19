import { describe, expect, it } from "vitest";
import { AGENT_ROUTE_PREFIXES } from "../agent-adapters/types.js";
import { matchWhitelistEndpoint } from "../routes/whitelist.js";

const knownRoutePrefixes = [
  "claude-code",
  "codebuddy",
  "codex",
  "workbuddy",
  "dsh",
  "opencode",
  "pi",
  "hermes",
  "openclaw",
  "cursor",
  "anthropic",
  "openai",
] as const;

describe("agent route prefixes", () => {
  it("keeps the runtime registry aligned with the supported route matrix", () => {
    expect(AGENT_ROUTE_PREFIXES).toEqual(knownRoutePrefixes);
  });

  it.each(knownRoutePrefixes)("normalizes %s OpenAI routes", (prefix) => {
    expect(
      matchWhitelistEndpoint(`/${prefix}/space-1/v1/chat/completions`),
    ).toMatchObject({
      pathSuffix: "/v1/chat/completions",
    });
  });

  it.each(knownRoutePrefixes)("normalizes %s Responses routes", (prefix) => {
    expect(matchWhitelistEndpoint(`/${prefix}/space-1/responses`)).toMatchObject({
      pathSuffix: "/responses",
    });
  });

  it("does not normalize an unknown prefix", () => {
    expect(
      matchWhitelistEndpoint("/not-an-agent/space-1/v1/chat/completions"),
    ).toBeNull();
  });

  it("does not discard a known prefix when the endpoint is not whitelisted", () => {
    expect(
      matchWhitelistEndpoint("/workbuddy/space-1/v1/not-whitelisted"),
    ).toBeNull();
  });
});
