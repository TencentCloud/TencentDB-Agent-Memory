import { describe, expect, it } from "vitest";
import { redactForgetPreview, renderForgetPreview, truncateForgetPreview } from "../forget-redaction.js";

describe("forget preview redaction", () => {
  it("removes common secrets before returning preview text", () => {
    const source = "Authorization: Bearer abc.def_123 and key sk-abcdefghijklmnop";
    const result = redactForgetPreview(source);

    expect(result).not.toContain("abc.def_123");
    expect(result).not.toContain("sk-abcdefghijklmnop");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts secrets from highlighted Core search snippets", () => {
    const source = "<mark>forget</mark> token sk - abcdefghijklmnop";
    const result = renderForgetPreview(source);

    expect(result).toBe("forget token [REDACTED]");
    expect(result).not.toContain("abcdefghijklmnop");
    expect(result).not.toContain("<mark>");
  });

  it("redacts values associated with sensitive field names", () => {
    const source = [
      '"password":"example-password-123"',
      "api_key='example-custom-key-456'",
      "client-secret=example-client-secret-789",
    ].join(" ");
    const result = redactForgetPreview(source);

    expect(result).not.toContain("example-password-123");
    expect(result).not.toContain("example-custom-key-456");
    expect(result).not.toContain("example-client-secret-789");
    expect(result).toContain("[REDACTED]");
  });

  it.each([
    ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["Authorization: Basic\n  dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["api_key: |\n  demo-secret-123", "demo-secret-123"],
    ["api_key: >-\n  demo-secret-123\n  second-line", "second-line"],
    ['{"credential":["first-secret","second-secret"]}', "second-secret"],
    ['prefix {"credential":["first-secret","second-secret"]}', "second-secret"],
    ['{"credential": {"nested": "broken-secret"', "broken-secret"],
    [JSON.stringify("Authorization: Basic dXNlcjpwYXNz"), "dXNlcjpwYXNz"],
    [JSON.stringify({ description: "api_key: |\n  demo-secret-123" }), "demo-secret-123"],
  ])("hides complete sensitive values in %s", (source, secret) => {
    const result = renderForgetPreview(source);
    expect(result).not.toContain(secret);
    expect(result).not.toContain("first-secret");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts whole nested JSON values while preserving non-sensitive fields", () => {
    const source = JSON.stringify({
      name: "deploy", items: [{ credential: ["first", "second"], enabled: true }],
      config: { API_KEY: { nested: "secret" }, password: null, retries: 3 },
    });
    expect(JSON.parse(redactForgetPreview(source))).toEqual({
      name: "deploy", items: [{ credential: "[REDACTED]", enabled: true }],
      config: { API_KEY: "[REDACTED]", password: "[REDACTED]", retries: 3 },
    });
  });

  it("recognizes escaped JSON field names", () => {
    expect(JSON.parse(redactForgetPreview('{"api\\u005fkey":"escaped-secret"}')))
      .toEqual({ api_key: "[REDACTED]" });
  });

  it("preserves ordinary text and redacts before truncation", () => {
    expect(renderForgetPreview("Deploy the application")).toBe("Deploy the application");
    const output = renderForgetPreview(`api_key: |\n  ${"secret".repeat(100)}`, 32);
    expect(output).not.toContain("secret");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(32);
  });

  it("stays valid UTF-8 and within budget at multibyte boundaries", () => {
    for (let budget = 0; budget <= 30; budget += 1) {
      const result = truncateForgetPreview("ß文😀€ß文ß🌍a", budget);
      expect(result).not.toContain("�");
      expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(budget);
    }
  });
});
