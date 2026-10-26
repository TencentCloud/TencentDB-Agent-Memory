import { describe, it, expect } from "vitest";
import { pythonCanonicalJson } from "./canonical-json.js";

describe("pythonCanonicalJson", () => {
  // Expected strings produced by python3 json.dumps(sort_keys=True,
  // separators=(",",":")) — see task fixtures.
  it("matches python json.dumps output exactly", () => {
    expect(
      pythonCanonicalJson({ count: 5, max_timestamp: "2026-10-26 10:00:00", users: { b: "x", a: "测" } }),
    ).toBe('{"count":5,"max_timestamp":"2026-10-26 10:00:00","users":{"a":"\\u6d4b","b":"x"}}');
    expect(pythonCanonicalJson({ a: [1, 2.5, "x"], b: null, c: { z: true } })).toBe(
      '{"a":[1,2.5,"x"],"b":null,"c":{"z":true}}',
    );
    expect(pythonCanonicalJson({ k: "𝌆", nested: { b: 1, a: [null, "café"] } })).toBe(
      '{"k":"\\ud834\\udf06","nested":{"a":[null,"caf\\u00e9"],"b":1}}',
    );
    // python3: json.dumps({"a":"x\x7fy","b":"\u2028"}, sort_keys=True, separators=(",",":"))
    expect(pythonCanonicalJson({ b: "\u2028", a: "x\x7fy" })).toBe('{"a":"x\\u007fy","b":"\\u2028"}');
  });

  it("changes when only one user's hash changes", () => {
    const base = { count: 2, max_timestamp: "t", users: { u1: "aaa", u2: "bbb" } };
    const changed = { ...base, users: { ...base.users, u2: "ccc" } };
    expect(pythonCanonicalJson(base)).not.toBe(pythonCanonicalJson(changed));
    // and the nested users object is actually serialized (not {})
    expect(pythonCanonicalJson(base)).toContain('"u1":"aaa"');
  });
});
