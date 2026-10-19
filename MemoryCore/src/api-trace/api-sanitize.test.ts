import { describe, expect, it } from "vitest";
import { sanitizeApiPayload } from "./api-sanitize.js";
import { summarizeArgs } from "./api-traced-proxy.js";

const ACCOUNT_INPUT = {
  group_id: "grp-1",
  provider_account_id: "acct-1",
  access_token: "eyJaccess-secret-value",
  refresh_token: "rt-refresh-secret-value",
};

describe("api trace redaction", () => {
  it("masks subscription tokens in logged payloads", () => {
    const logged = JSON.stringify(sanitizeApiPayload({ accounts: [ACCOUNT_INPUT] }, 1000));
    expect(logged).not.toContain("access-secret-value");
    expect(logged).not.toContain("refresh-secret-value");
    expect(logged).toContain("acct-1");
  });

  it("masks sensitive fields of a traced method argument", () => {
    const logged = JSON.stringify(summarizeArgs([{ ...ACCOUNT_INPUT, api_key: "sk-upstream-secret-value" }], 1000));
    expect(logged).not.toMatch(/secret-value/);
    expect(logged).toContain("grp-1");
  });
});
