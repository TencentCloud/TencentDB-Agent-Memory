/**
 * applyCorsHeaders must advertise every request header the v2/v3/metadata
 * routers read — otherwise any configured corsOrigins makes every browser
 * preflight for those routes fail.
 */
import { describe, it, expect } from "vitest";
import { TdaiGateway } from "./server.js";

function makeGateway(corsOrigins: string[]) {
  const gw = Object.create(TdaiGateway.prototype) as Record<string, unknown>;
  gw.config = { server: { corsOrigins } };
  return gw as unknown as {
    applyCorsHeaders(req: unknown, res: unknown): void;
  };
}

function makeRes() {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader(k: string, v: string) {
      headers.set(k, v);
    },
  };
}

const EXPECTED_TDAI_HEADERS = [
  "x-tdai-service-id",
  "x-tdai-user-key",
  "x-tdai-team-id",
  "x-tdai-agent-id",
  "x-tdai-user-id",
  "x-tdai-session-id",
  "x-tdai-task-id",
  "x-request-id",
];

describe("TdaiGateway.applyCorsHeaders", () => {
  it("wildcard branch advertises all x-tdai-* headers, methods and max-age", () => {
    const gw = makeGateway(["*"]);
    const res = makeRes();
    gw.applyCorsHeaders({ headers: {} }, res);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("600");
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers")!;
    for (const h of ["Content-Type", "Authorization", "Content-Encoding", ...EXPECTED_TDAI_HEADERS]) {
      expect(allowHeaders).toContain(h);
    }
  });

  it("allow-listed origin gets the same header set plus Vary", () => {
    const gw = makeGateway(["https://panel.example"]);
    const res = makeRes();
    gw.applyCorsHeaders({ headers: { origin: "https://panel.example" } }, res);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://panel.example");
    expect(res.headers.get("Vary")).toBe("Origin");
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers")!;
    for (const h of EXPECTED_TDAI_HEADERS) {
      expect(allowHeaders).toContain(h);
    }
    expect(res.headers.get("Access-Control-Max-Age")).toBe("600");
  });

  it("non-listed origin emits only Vary (no CORS grant)", () => {
    const gw = makeGateway(["https://panel.example"]);
    const res = makeRes();
    gw.applyCorsHeaders({ headers: { origin: "https://evil.example" } }, res);

    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(res.headers.has("Access-Control-Allow-Headers")).toBe(false);
  });

  it("empty allow-list emits nothing", () => {
    const gw = makeGateway([]);
    const res = makeRes();
    gw.applyCorsHeaders({ headers: { origin: "https://panel.example" } }, res);
    expect(res.headers.size).toBe(0);
  });
});
