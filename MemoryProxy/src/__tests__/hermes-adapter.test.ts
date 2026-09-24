import { describe, it, expect } from "vitest";
import { hermesAdapter } from "../agent-adapters/hermes.js";

describe("hermesAdapter", () => {
  it("classifyRequest always returns main", () => {
    expect(hermesAdapter.classifyRequest({}, "/hermes/default/v1/chat/completions", {})).toBe("main");
  });

  it("extractUserText returns string content directly", () => {
    expect(hermesAdapter.extractUserText("hello")).toBe("hello");
  });

  it("extractUserText returns null for empty string", () => {
    expect(hermesAdapter.extractUserText("")).toBeNull();
  });

  it("extractUserText falls back to default for non-string", () => {
    expect(hermesAdapter.extractUserText(null)).toBeNull();
  });
});
