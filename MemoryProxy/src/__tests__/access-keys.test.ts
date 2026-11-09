import { describe, expect, it } from "vitest";

import { isAllowed, parseAccessKeys, presentedKeys } from "../accessKeys.js";

describe("parseAccessKeys", () => {
  it("strips blank lines and comments", () => {
    expect(parseAccessKeys("# comment\nkey-one\n\n  key-two  \n"))
      .toEqual(["key-one", "key-two"]);
  });

  it("handles CRLF and inline comments", () => {
    expect(parseAccessKeys("alpha\r\nbeta # trailing note\r\n"))
      .toEqual(["alpha", "beta"]);
  });

  it("returns an empty list for empty or comment-only input", () => {
    expect(parseAccessKeys("")).toEqual([]);
    expect(parseAccessKeys("# only a comment\n")).toEqual([]);
  });
});

describe("presentedKeys", () => {
  it("reads a Bearer credential case-insensitively", () => {
    expect(presentedKeys(new Headers({ authorization: "bearer abc" })))
      .toEqual(["abc"]);
  });

  it("reads the x-api-key header", () => {
    expect(presentedKeys(new Headers({ "x-api-key": "xyz" })))
      .toEqual(["xyz"]);
  });

  it("returns both credentials when both headers are present", () => {
    const headers = new Headers({ authorization: "Bearer abc", "x-api-key": "xyz" });
    expect(presentedKeys(headers)).toEqual(["abc", "xyz"]);
  });

  it("returns an empty list when no credential is present", () => {
    expect(presentedKeys(new Headers())).toEqual([]);
    expect(presentedKeys(new Headers({ authorization: "Basic abc" }))).toEqual([]);
  });
});

describe("isAllowed", () => {
  it("accepts a matching key", () => {
    expect(isAllowed(["secret"], ["other", "secret"])).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(isAllowed(["wrong"], ["secret"])).toBe(false);
  });

  it("accepts when any of the presented keys match", () => {
    expect(isAllowed(["wrong", "secret"], ["secret"])).toBe(true);
  });

  it("rejects empty inputs", () => {
    expect(isAllowed([], ["secret"])).toBe(false);
    expect(isAllowed(["secret"], [])).toBe(false);
  });

  it("does not match on a prefix", () => {
    expect(isAllowed(["sec"], ["secret"])).toBe(false);
  });
});
