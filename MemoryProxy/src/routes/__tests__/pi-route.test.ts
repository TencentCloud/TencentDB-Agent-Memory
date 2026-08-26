import { describe, expect, it } from "vitest";
import { extractSpaceIdFromPath } from "../../credit-reporter.js";
import { normalizeWhitelistRequestPath } from "../whitelist.js";

describe("Pi routes", () => {
  it("normalizes the generic Pi agent prefix", () => {
    expect(normalizeWhitelistRequestPath("/pi/mem-example/v1/chat/completions")).toBe("/v1/chat/completions");
  });

  it("attributes Pi credit usage to its space", () => {
    expect(extractSpaceIdFromPath("/pi/mem-example/v1/chat/completions")).toBe("mem-example");
  });
});
