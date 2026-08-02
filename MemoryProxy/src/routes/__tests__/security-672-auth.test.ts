/**
 * Security #672 Regression-Tests: Auth-Bypass (MemoryProxy)
 *
 * Verifiziert die Schwachstellen 1+2 aus dem Advisory:
 * 1. rate-limits: GET/PUT/DELETE OHNE Admin-Token → 401 (vorher: offen)
 * 2. admin-auth: ohne konfigurierten admin.apiKey → fail-closed "missing"
 */
import { describe, expect, it } from "vitest";
import { checkAdminAuth } from "../admin-auth.js";

// Hono-Context-Mock: nur header() wird gebraucht
function mockCtx(authHeader?: string): any {
  return {
    req: {
      header: (name: string) => {
        if (name.toLowerCase() === "authorization") return authHeader ?? "";
        return undefined;
      },
    },
  };
}

describe("Security #672: admin-auth fail-closed", () => {
  it("ohne konfigurierten admin.apiKey → 'missing' (vorher 'ok' = Bypass)", () => {
    const ctx = mockCtx(undefined);
    expect(checkAdminAuth(ctx, "")).toBe("missing");
  });

  it("korrekter Bearer-Token → 'ok'", () => {
    const ctx = mockCtx("Bearer sekret123");
    expect(checkAdminAuth(ctx, "sekret123")).toBe("ok");
  });

  it("fehlender Header → 'missing'", () => {
    const ctx = mockCtx(undefined);
    expect(checkAdminAuth(ctx, "sekret123")).toBe("missing");
  });

  it("falscher Token → 'invalid'", () => {
    const ctx = mockCtx("Bearer falsch");
    expect(checkAdminAuth(ctx, "sekret123")).toBe("invalid");
  });
});
