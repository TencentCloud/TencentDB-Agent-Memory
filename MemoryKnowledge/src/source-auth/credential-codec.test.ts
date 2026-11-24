import { describe, expect, it } from "vitest";

import { decodeSecret, encodeSecret } from "./credential-codec.js";

/**
 * `cred_secret` is written through encodeSecret(), so every valid row is
 * canonical base64 of a well-formed UTF-8 string. A corrupted row must be
 * reported as null: the credential store treats null as "not configured"
 * rather than handing the value to git as a clone token.
 */
describe("decodeSecret", () => {
  it("round-trips values written by encodeSecret", () => {
    for (const plain of ["s3cr3t-token", "令牌-密钥-abc", "tok\u{1F511}en", "\uFEFFtoken"]) {
      expect(decodeSecret(encodeSecret(plain))).toBe(plain);
    }
  });

  it("still accepts valid base64 that is not produced by encodeSecret", () => {
    expect(decodeSecret("YWJj")).toBe("abc");
    expect(decodeSecret("YQ==")).toBe("a");
    expect(decodeSecret("w6k=")).toBe("\u00E9");
    expect(decodeSecret("AGEA")).toBe("\u0000a\u0000");
  });

  it("rejects null, empty and structurally invalid input", () => {
    expect(decodeSecret(null)).toBeNull();
    expect(decodeSecret(undefined)).toBeNull();
    expect(decodeSecret("")).toBeNull();
    expect(decodeSecret("!!!!")).toBeNull();
    expect(decodeSecret("====")).toBeNull();
    expect(decodeSecret("YWJj!A==")).toBeNull();
    expect(decodeSecret("YWJjZ")).toBeNull();
    expect(decodeSecret("YWJjZA")).toBeNull();
  });

  it("rejects base64 whose bytes are not valid UTF-8", () => {
    // Node's UTF-8 decoder substitutes U+FFFD for malformed sequences instead
    // of throwing, so charset + length checks alone are not enough.
    expect(decodeSecret("/w==")).toBeNull(); // lone 0xFF
    expect(decodeSecret("ww==")).toBeNull(); // truncated 2-byte sequence
    expect(decodeSecret("gA==")).toBeNull(); // lone continuation byte
    expect(decodeSecret("wIA=")).toBeNull(); // overlong encoding
    expect(decodeSecret("7aCA")).toBeNull(); // encoded surrogate
    expect(decodeSecret(Buffer.from([0xe4, 0xb8]).toString("base64"))).toBeNull();
    expect(decodeSecret(Buffer.from([0xf0, 0x9f, 0x94]).toString("base64"))).toBeNull();
    expect(decodeSecret(Buffer.from([0x61, 0xff, 0x62]).toString("base64"))).toBeNull();
  });
});
