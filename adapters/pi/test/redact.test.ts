import { describe, expect, it } from "vitest";
import { redact, safeJson, sanitizeStructured, sensitiveKey } from "../src/redact.js";

describe("redact", () => {
  it("removes a closed recalled-memory block", () => {
    const input = "before BEGIN_TENCENTDB_RECALLED_MEMORY(secret)END_TENCENTDB_RECALLED_MEMORY after";
    expect(redact(input)).toBe("before [recalled memory omitted] after");
  });

  it("removes an unclosed recalled-memory block (truncated BEGIN with no END)", () => {
    const input = "BEGIN_TENCENTDB_RECALLED_MEMORY(leaked instructions continue...";
    expect(redact(input)).toBe("[recalled memory omitted]");
  });

  it("redacts bearer tokens", () => {
    expect(redact("Authorization: Bearer abc.def.ghi-token")).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts a closed private key block", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----";
    expect(redact(input)).toBe("[private key redacted]");
  });

  it("redacts an unclosed private key block", () => {
    const input = "-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEo...";
    expect(redact(input)).toBe("[private key redacted]");
  });

  it("redacts credentials embedded in a URL", () => {
    expect(redact("postgres://user:pass@host:5432/db")).toBe("postgres://[REDACTED]:[REDACTED]@host:5432/db");
  });

  it("redacts a sensitive key with a quoted value containing spaces", () => {
    expect(redact('api_key="my secret value"')).toBe('api_key="[REDACTED]"');
  });

  it("redacts a sensitive key with an unquoted value", () => {
    expect(redact("token=abc123")).toBe('token="[REDACTED]"');
  });

  it("does not redact non-sensitive keys", () => {
    expect(redact("count=42 name=\"alice\"")).toBe('count=42 name="alice"');
  });
});

describe("sensitiveKey", () => {
  it.each([
    ["api_key", true],
    ["API-KEY", true],
    ["access_token", true],
    ["PASSWORD", true],
    ["private_key", true],
    ["authorization", true],
    ["cookie", true],
    ["username", false],
    ["count", false],
    ["session_id", false],
  ])("classifies %s as %s", (key, expected) => {
    expect(sensitiveKey(key)).toBe(expected);
  });
});

describe("sanitizeStructured", () => {
  it("recursively redacts sensitive values in nested JSON", () => {
    const input = {
      tool: "read",
      config: { api_key: "sk-live-123", nested: { token: "t" } },
      safe: "ok",
    };
    const result = sanitizeStructured(input) as Record<string, unknown>;
    const config = result.config as Record<string, unknown>;
    const nested = config.nested as Record<string, unknown>;
    expect(config.api_key).toBe("[REDACTED]");
    expect(nested.token).toBe("[REDACTED]");
    expect(result.safe).toBe("ok");
  });

  it("redacts secret-shaped substrings inside string values", () => {
    const result = sanitizeStructured({ note: "Bearer abc.def.ghi" }) as Record<string, unknown>;
    expect(result.note).toBe("Bearer [REDACTED]");
  });

  it("handles circular references", () => {
    const input: Record<string, unknown> = { a: "x" };
    input.self = input;
    const result = sanitizeStructured(input) as Record<string, unknown>;
    expect(result.self).toBe("[circular]");
    expect(result.a).toBe("x");
  });
});

describe("safeJson", () => {
  it("serializes redacted structured arguments", () => {
    const result = safeJson({ name: "auth", arguments: { api_key: "leak" } });
    expect(result).not.toContain("leak");
    expect(result).toContain("[REDACTED]");
  });

  it("falls back when input cannot be serialized", () => {
    const circular: unknown = {};
    (circular as Record<string, unknown>).self = circular;
    // BigInt also throws on JSON.stringify; use it to force the fallback path.
    expect(safeJson({ big: BigInt(1) })).toBe("[unserializable arguments]");
  });
});
