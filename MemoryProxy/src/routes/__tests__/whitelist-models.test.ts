/**
 * Regression: GET /v1/models must resolve through the whitelist.
 *
 * Claude Code discovers models by calling the bare `/v1/models` (no
 * agent/spaceId prefix). Only `/:agent/:spaceId/v1/models` was registered,
 * so the bare path fell through to the catch-all and returned 404; the aux
 * pipeline additionally 404s at matchWhitelistEndpoint when no entry exists.
 */

import { describe, expect, it } from "vitest";
import { matchWhitelistEndpoint } from "../whitelist.js";

describe("whitelist: /v1/models", () => {
  it("matches the bare path", () => {
    const entry = matchWhitelistEndpoint("/v1/models");
    expect(entry).not.toBeNull();
    expect(entry?.upstreamEndpoint).toBe("/models");
  });

  it("matches the agent/space-prefixed path", () => {
    const entry = matchWhitelistEndpoint("/claude-code/my-space/v1/models");
    expect(entry?.upstreamEndpoint).toBe("/models");
  });

  it("is a non-streaming, non-primary endpoint", () => {
    // Primary endpoints count as a conversation turn; model discovery must not.
    const entry = matchWhitelistEndpoint("/v1/models");
    expect(entry?.supportsStream).toBe(false);
    expect(entry?.isPrimary).toBe(false);
  });

  it("does not shadow /v1/messages", () => {
    // Longest-suffix matching must still route messages to its own entry.
    const entry = matchWhitelistEndpoint("/v1/messages");
    expect(entry?.upstreamEndpoint).toBe("/messages");
  });
});
