import { describe, expect, it } from "vitest";
import { sseDataValue } from "../anthropicHandler.js";

describe("sseDataValue", () => {
  it("reads a data field written with the conventional space", () => {
    expect(sseDataValue('data: {"type":"ping"}')).toBe('{"type":"ping"}');
  });

  // Previously the SSE parsers matched only `"data: "`, so a conforming
  // upstream that omitted the optional space had its frames skipped — and the
  // thinking-fix stream exists precisely for upstreams that do not conform.
  it("reads a data field written without the optional space", () => {
    expect(sseDataValue('data:{"type":"ping"}')).toBe('{"type":"ping"}');
  });

  it("strips only the single framing space", () => {
    expect(sseDataValue("data:  padded")).toBe(" padded");
  });

  it("reads an empty data field either way", () => {
    expect(sseDataValue("data:")).toBe("");
    expect(sseDataValue("data: ")).toBe("");
  });

  it("ignores lines that are not data fields", () => {
    expect(sseDataValue("event: message")).toBeUndefined();
    expect(sseDataValue(": keep-alive")).toBeUndefined();
    expect(sseDataValue("")).toBeUndefined();
  });

  it("does not treat a longer field name as data", () => {
    expect(sseDataValue("database: value")).toBeUndefined();
  });

  it("distinguishes a missing data field from an empty one", () => {
    // The stream loop relies on `undefined` meaning "no data line in this
    // frame"; an empty string is a real, empty data field.
    expect(sseDataValue("data:")).not.toBeUndefined();
    expect(sseDataValue("id: 1")).toBeUndefined();
  });
});
