import { describe, expect, it } from "vitest";
import {
  hasAnalyseMarker,
  hasCostGuardMarker,
  matchWhitelistEndpoint,
  normalizeWhitelistRequestPath,
} from "../whitelist";

describe("normalizeWhitelistRequestPath with pi agent prefix", () => {
  it("strips /pi without spaceId", () => {
    expect(normalizeWhitelistRequestPath("/pi/v1/messages")).toBe("/v1/messages");
  });

  it("strips /pi/{spaceId} for anthropic messages", () => {
    expect(normalizeWhitelistRequestPath("/pi/team-abc/v1/messages")).toBe(
      "/v1/messages",
    );
  });

  it("strips /pi/{spaceId} for openai chat completions", () => {
    expect(normalizeWhitelistRequestPath("/pi/team-abc/v1/chat/completions")).toBe(
      "/v1/chat/completions",
    );
  });

  it("strips /pi/{spaceId} for codex-style responses", () => {
    expect(normalizeWhitelistRequestPath("/pi/team-abc/responses")).toBe(
      "/responses",
    );
  });

  it("strips /pi/{spaceId} for memories and realtime tails", () => {
    expect(
      normalizeWhitelistRequestPath("/pi/team-abc/memories/trace_summarize"),
    ).toBe("/memories/trace_summarize");
    expect(normalizeWhitelistRequestPath("/pi/team-abc/realtime/calls")).toBe(
      "/realtime/calls",
    );
  });
});

describe("cost-guard / analyse markers on /pi paths", () => {
  it("detects and strips /cost-guard marker", () => {
    const path = "/pi/team-abc/cost-guard/v1/messages";
    expect(hasCostGuardMarker(path)).toBe(true);
    expect(normalizeWhitelistRequestPath(path)).toBe("/v1/messages");
  });

  it("detects and strips /analyse marker", () => {
    const path = "/pi/team-abc/analyse/v1/messages";
    expect(hasAnalyseMarker(path)).toBe(true);
    expect(normalizeWhitelistRequestPath(path)).toBe("/v1/messages");
  });
});

describe("matchWhitelistEndpoint on /pi paths", () => {
  it("matches the primary anthropic endpoint", () => {
    expect(matchWhitelistEndpoint("/pi/team-abc/v1/messages")?.pathSuffix).toBe(
      "/v1/messages",
    );
  });

  it("matches the primary openai endpoint", () => {
    expect(
      matchWhitelistEndpoint("/pi/team-abc/v1/chat/completions")?.pathSuffix,
    ).toBe("/v1/chat/completions");
  });

  it("does not match unknown tails", () => {
    expect(matchWhitelistEndpoint("/pi/team-abc/v1/unknown")).toBeNull();
  });
});

describe("regression: existing agent prefixes still normalize", () => {
  it("strips /claude-code/{spaceId}", () => {
    expect(normalizeWhitelistRequestPath("/claude-code/team-abc/v1/messages")).toBe(
      "/v1/messages",
    );
  });

  it("strips /codebuddy/{spaceId}", () => {
    expect(
      normalizeWhitelistRequestPath("/codebuddy/team-abc/v1/chat/completions"),
    ).toBe("/v1/chat/completions");
  });

  it("keeps bare whitelist entries untouched", () => {
    expect(normalizeWhitelistRequestPath("/v1/messages")).toBe("/v1/messages");
    expect(normalizeWhitelistRequestPath("/responses")).toBe("/responses");
  });
});
