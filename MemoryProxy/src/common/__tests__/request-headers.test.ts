import { describe, expect, it } from "vitest";
import {
  SKIP_REQUEST_HEADERS_HOP_BY_HOP,
  SKIP_REQUEST_HEADERS_WITH_INTERNAL,
} from "../constants.js";

describe("upstream request header filters", () => {
  it.each([
    ["standard", SKIP_REQUEST_HEADERS_HOP_BY_HOP],
    ["with internal headers blocked", SKIP_REQUEST_HEADERS_WITH_INTERNAL],
  ] as const)("does not forward Expect: 100-continue (%s)", (_label, skipped) => {
    const incoming = new Headers({
      Expect: "100-continue",
      "Content-Type": "application/json",
    });
    const upstream = new Headers([...incoming].filter(([name]) => !skipped.has(name)));

    expect(upstream.has("expect")).toBe(false);
    expect(upstream.get("content-type")).toBe("application/json");
  });
});
