import { describe, expect, it } from "vitest";
import { isDshHeadlessRequest } from "../dsh.js";

describe("isDshHeadlessRequest", () => {
  it("detects a DSH tool request without ask_user_question", () => {
    expect(isDshHeadlessRequest({
      tools: [{ type: "function", function: { name: "bash" } }],
    })).toBe(true);
  });

  it("keeps interactive DSH requests out of headless mode", () => {
    expect(isDshHeadlessRequest({
      tools: [
        { type: "function", function: { name: "bash" } },
        { type: "function", function: { name: "ask_user_question" } },
      ],
    })).toBe(false);
  });

  it("treats missing and empty tool catalogues as headless", () => {
    expect(isDshHeadlessRequest({ tools: [] })).toBe(true);
    expect(isDshHeadlessRequest({})).toBe(true);
  });
});
