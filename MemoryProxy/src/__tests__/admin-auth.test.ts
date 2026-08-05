/**
 * Security tests for #672 (CWE-287) — checkAdminAuth must deny by default when
 * admin.apiKey is unconfigured.
 */

import { describe, expect, it } from "vitest";
import { checkAdminAuth } from "../routes/admin-auth.js";

function ctx(header?: string): any {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === "authorization" ? header : undefined,
    },
  };
}

describe("checkAdminAuth (#672)", () => {
  it("denies when admin.apiKey is unconfigured (default deny)", () => {
    expect(checkAdminAuth(ctx("Bearer whatever"), "")).toBe("missing");
  });

  it("accepts a matching Bearer token", () => {
    expect(checkAdminAuth(ctx("Bearer secret"), "secret")).toBe("ok");
  });

  it("rejects a wrong token", () => {
    expect(checkAdminAuth(ctx("Bearer wrong"), "secret")).toBe("invalid");
  });

  it("rejects a missing Authorization header", () => {
    expect(checkAdminAuth(ctx(), "secret")).toBe("missing");
  });
});
