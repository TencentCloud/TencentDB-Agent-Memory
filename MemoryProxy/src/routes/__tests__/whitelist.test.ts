import { describe, expect, it } from "vitest";
import { normalizeWhitelistRequestPath } from "../whitelist.js";
import { extractSpaceIdFromPath } from "../../credit-reporter.js";
import { resolveAgentAdapter } from "../../agent-adapters/index.js";

describe("zcode agent prefix registration", () => {
  it("strips /zcode/:spaceId prefix for whitelist matching", () => {
    expect(
      normalizeWhitelistRequestPath("/zcode/mem-example001/v1/messages"),
    ).toBe("/v1/messages");
  });

  it("strips prefix and cost-guard marker together", () => {
    expect(
      normalizeWhitelistRequestPath(
        "/zcode/mem-example001/cost-guard/v1/messages",
      ),
    ).toBe("/v1/messages");
  });

  it("extracts spaceId for auth (same list as whitelist)", () => {
    expect(extractSpaceIdFromPath("/zcode/mem-example001/v1/messages")).toBe(
      "mem-example001",
    );
  });

  it("resolves a dedicated zcode adapter", () => {
    expect(resolveAgentAdapter("zcode").agentKind).toBe("zcode");
  });
});
