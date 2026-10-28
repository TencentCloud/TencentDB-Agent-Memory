import { describe, expect, it } from "vitest";
import { isSensitiveApiKey, redactSqlParams, sanitizeApiPayload } from "./api-sanitize.js";

const LONG_KEY = "sk-mem-0123456789abcdef0123456789abcdef";

describe("sanitizeApiPayload", () => {
  it("redacts sensitive keys regardless of casing or separator style", () => {
    const out = sanitizeApiPayload(
      {
        userKey: LONG_KEY,
        "x-tdai-user-key": LONG_KEY,
        apiKey: LONG_KEY,
        accessToken: LONG_KEY,
        refresh_token: LONG_KEY,
        client_secret: LONG_KEY,
        secretKey: LONG_KEY,
      },
      300,
    ) as Record<string, string>;
    for (const v of Object.values(out)) expect(v).toBe("sk-mem-0…");
  });

  it("never leaks passwords or short secrets, even partially", () => {
    const out = sanitizeApiPayload(
      { password: "hunter2", new_password: "a-very-long-password-value-123", token: "abc123" },
      300,
    ) as Record<string, string>;
    expect(out).toEqual({ password: "[redacted]", new_password: "[redacted]", token: "[redacted]" });
  });

  it("leaves ordinary fields alone", () => {
    const input = { max_tokens: 100, total_tokens: 5, keyword: "x", user_id: "u1", nested: [{ name: "n" }] };
    expect(sanitizeApiPayload(input, 300)).toEqual(input);
  });

  it("isSensitiveApiKey keeps the original exact-match list working", () => {
    for (const k of ["password", "initial_password", "user_key", "key_value", "granted_by_key", "authorization", "bearer"]) {
      expect(isSensitiveApiKey(k)).toBe(true);
    }
  });
});

describe("redactSqlParams", () => {
  it("does not redact ordinary long values that merely contain 'sk_'", () => {
    const v = "task_0123456789abcdef0123456789abcdef";
    expect(redactSqlParams([v], 300)).toEqual([v]);
  });

  it("redacts long credential-looking values", () => {
    expect(redactSqlParams([LONG_KEY, `Bearer ${LONG_KEY}`, `sk_${"a".repeat(40)}`], 300)).toEqual([
      "[redacted]",
      "[redacted]",
      "[redacted]",
    ]);
  });
});
