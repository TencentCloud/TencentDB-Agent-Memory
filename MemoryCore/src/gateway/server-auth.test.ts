/**
 * RFC 7235 auth schemes are case-insensitive — "bearer <key>" and
 * "BEARER <key>" must be accepted exactly like "Bearer <key>", in both
 * verifyAuth (v1/admin) and parseV2Auth (v2/v3).
 */
import { describe, it, expect, vi } from "vitest";
import type http from "node:http";
import { TdaiGateway } from "./server.js";
import { parseV2Auth } from "./v2-router.js";

function reqWith(authorization?: string, extra: Record<string, string> = {}) {
  return {
    headers: { ...(authorization === undefined ? {} : { authorization }), ...extra },
  } as http.IncomingMessage;
}

function makeGateway(apiKey?: string) {
  const gw = Object.create(TdaiGateway.prototype) as Record<string, unknown>;
  gw.config = { server: { apiKey } };
  return gw as unknown as {
    verifyAuth(req: http.IncomingMessage): "ok" | "missing" | "invalid";
  };
}

describe("verifyAuth Bearer scheme", () => {
  const gw = makeGateway("secret-key");

  it.each([
    ["Bearer secret-key", "ok"],
    ["bearer secret-key", "ok"],
    ["BEARER secret-key", "ok"],
    ["Bearer   secret-key", "ok"],
    ["Bearer wrong", "invalid"],
    ["Basic secret-key", "missing"],
    ["Bearer", "missing"],
    ["BearerXsecret-key", "missing"],
  ] as const)("Authorization: %s → %s", (header, expected) => {
    expect(gw.verifyAuth(reqWith(header))).toBe(expected);
  });

  it("missing header → missing; disabled auth → ok", () => {
    expect(gw.verifyAuth(reqWith())).toBe("missing");
    expect(makeGateway(undefined).verifyAuth(reqWith())).toBe("ok");
    expect(makeGateway(undefined).verifyAuth(reqWith("bearer whatever"))).toBe("ok");
  });
});

describe("parseV2Auth Bearer scheme", () => {
  function sendJsonSpy() {
    return vi.fn();
  }

  it("accepts case-insensitive Bearer and returns the apiKey", () => {
    const sendJson = sendJsonSpy();
    const ctx = parseV2Auth(
      reqWith("bearer user-key-1", { "x-tdai-service-id": "svc-1" }),
      {} as http.ServerResponse,
      "req-1",
      sendJson,
    );
    expect(ctx).not.toBeNull();
    expect((ctx as { apiKey: string }).apiKey).toBe("user-key-1");
    expect((ctx as { serviceId: string }).serviceId).toBe("svc-1");
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("rejects non-Bearer and empty schemes with 401", () => {
    for (const header of ["Basic abc", "Bearer", "BearerXabc", ""]) {
      const sendJson = sendJsonSpy();
      const ctx = parseV2Auth(
        reqWith(header, { "x-tdai-service-id": "svc-1" }),
        {} as http.ServerResponse,
        "req-1",
        sendJson,
      );
      expect(ctx).toBeNull();
      expect(sendJson).toHaveBeenCalledTimes(1);
    }
  });

  it("still requires x-tdai-service-id", () => {
    const sendJson = sendJsonSpy();
    const ctx = parseV2Auth(
      reqWith("bearer user-key-1"),
      {} as http.ServerResponse,
      "req-1",
      sendJson,
    );
    expect(ctx).toBeNull();
    expect(sendJson).toHaveBeenCalledTimes(1);
  });
});
