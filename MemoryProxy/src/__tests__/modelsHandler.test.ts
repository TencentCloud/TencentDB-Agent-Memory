import { describe, expect, it } from "vitest";
import { resolveModelsUpstreamUrl } from "../modelsHandler.js";

describe("resolveModelsUpstreamUrl (agent-agnostic)", () => {
  it("appends /models to a bare /v1 base", () => {
    expect(resolveModelsUpstreamUrl("http://models.example.com/v1")).toBe(
      "http://models.example.com/v1/models",
    );
  });

  it("appends /models to a root base", () => {
    expect(resolveModelsUpstreamUrl("http://models.example.com")).toBe(
      "http://models.example.com/models",
    );
  });

  it("strips a trailing slash from the base", () => {
    expect(resolveModelsUpstreamUrl("http://models.example.com/v1/")).toBe(
      "http://models.example.com/v1/models",
    );
  });

  it("is identical for every inbound path shape (path is ignored)", () => {
    const base = "http://models.example.com/v1";
    const expected = "http://models.example.com/v1/models";
    expect(resolveModelsUpstreamUrl(base)).toBe(expected);
    // The handler ignores the path, so the URL never changes no matter what
    // agent / spaceId / v1 segments the client used.
  });
});
