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

  it("stays valid UTF-8 and within budget at multibyte boundaries", () => {
    for (let budget = 0; budget <= 30; budget += 1) {
      const result = truncateForgetPreview("ß文😀€ß文ß🌍a", budget);
      expect(result).not.toContain("�");
      expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(budget);
    }
  });
});
