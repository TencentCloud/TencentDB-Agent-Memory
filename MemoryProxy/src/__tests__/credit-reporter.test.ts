import { describe, it, expect } from "vitest";
import { extractSpaceIdFromPath } from "../credit-reporter.js";

/**
 * extractSpaceIdFromPath derives the service/space id from the request path and
 * gates it on a hardcoded agent allowlist. This test pins that `pi` (added as a
 * first-class agent-source) extracts correctly, and guards against regressions
 * where a new agent is registered but forgotten in the allowlist (which 401s
 * every request with "missing service_id").
 */
describe("extractSpaceIdFromPath", () => {
  it("extracts the spaceId for the pi agent-source", () => {
    expect(extractSpaceIdFromPath("/pi/default/v1/chat/completions")).toBe("default");
  });

  it("extracts a custom spaceId for pi", () => {
    expect(extractSpaceIdFromPath("/pi/mem-prod-001/v1/chat/completions")).toBe(
      "mem-prod-001",
    );
  });

  it("still extracts for the established agent-sources (no regression)", () => {
    expect(extractSpaceIdFromPath("/codebuddy/default/v1/chat/completions")).toBe("default");
    expect(extractSpaceIdFromPath("/claude-code/team-x/v1/messages")).toBe("team-x");
  });

  it("returns null for an unregistered agent-source (the failure mode this test guards)", () => {
    expect(extractSpaceIdFromPath("/unknown-agent/default/v1/chat/completions")).toBeNull();
  });
});
