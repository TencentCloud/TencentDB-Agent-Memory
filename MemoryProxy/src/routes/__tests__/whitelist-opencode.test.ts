import { describe, expect, it } from "vitest";

import {
  hasAnalyseMarker,
  hasCostGuardMarker,
  matchWhitelistEndpoint,
  normalizeWhitelistRequestPath,
} from "../whitelist.js";

/**
 * Regression coverage for opencode in AGENT_PREFIX_RE.
 *
 * The first-class opencode adapter (agent-adapters/opencode.ts, present since
 * v2.0.1) handles /opencode/{spaceId}/v1/... requests, but AGENT_PREFIX_RE did
 * not include "opencode" — the same gap #1195 fixed for pi. Cost-guard /
 * analyse markers on /opencode paths were not recognized and whitelist
 * matching missed. Mirror of the pi coverage pattern from #1195.
 */

describe("normalizeWhitelistRequestPath — opencode prefix", () => {
  it("strips /opencode/{spaceId} agent prefix (with /v1 tail)", () => {
    expect(
      normalizeWhitelistRequestPath("/opencode/mem-example001/v1/chat/completions"),
    ).toBe("/v1/chat/completions");
  });

  it("strips /opencode/{spaceId} agent prefix (anthropic tail)", () => {
    expect(normalizeWhitelistRequestPath("/opencode/mem-example001/v1/messages")).toBe(
      "/v1/messages",
    );
  });

  it("strips /opencode/{spaceId}/cost-guard marker then agent prefix", () => {
    expect(
      normalizeWhitelistRequestPath(
        "/opencode/mem-example001/cost-guard/v1/chat/completions",
      ),
    ).toBe("/v1/chat/completions");
  });

  it("strips /opencode/{spaceId}/analyse marker then agent prefix", () => {
    expect(
      normalizeWhitelistRequestPath("/opencode/mem-example001/analyse/v1/chat/completions"),
    ).toBe("/v1/chat/completions");
  });
});

describe("markers on /opencode paths", () => {
  it("recognizes cost-guard marker on /opencode path", () => {
    expect(hasCostGuardMarker("/opencode/s1/cost-guard/v1/chat/completions")).toBe(true);
  });

  it("recognizes analyse marker on /opencode path", () => {
    expect(hasAnalyseMarker("/opencode/s1/analyse/v1/chat/completions")).toBe(true);
  });
});

describe("whitelist matching on /opencode paths", () => {
  it("matches a whitelisted endpoint after /opencode/{spaceId}", () => {
    const hit = matchWhitelistEndpoint("/opencode/s1/v1/chat/completions");
    expect(hit?.pathSuffix).toBe("/v1/chat/completions");
  });
});
