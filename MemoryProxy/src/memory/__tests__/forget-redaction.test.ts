import { describe, expect, it } from "vitest";
import { redactForgetPreview, renderForgetPreview, truncateForgetPreview } from "../forget-redaction.js";

describe("forget preview redaction", () => {
  it("removes common secrets before returning preview text", () => {
    const source = "Authorization: Bearer abc.def_123 and key sk-abcdefghijklmnop";
    const result = redactForgetPreview(source);

    expect(result).not.toContain("abc.def_123");
    expect(result).not.toContain("sk-abcdefghijklmnop");
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(2);
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
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it("stays valid UTF-8 and within budget at multibyte boundaries", () => {
    for (let budget = 0; budget <= 30; budget += 1) {
      const result = truncateForgetPreview("ß文😀€ß文ß🌍a", budget);
      expect(result).not.toContain("�");
      expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(budget);
    }
  });
});
