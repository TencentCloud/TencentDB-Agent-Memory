import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { TdaiGateway } from "../server.js";

async function request(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Gateway CORS is opt-in (server.corsOrigins)", () => {
  let gatewayWithoutCors: TdaiGateway;
  let gatewayWithCors: TdaiGateway;
  const PORT_NO_CORS = 18431;
  const PORT_WITH_CORS = 18433;

  beforeAll(async () => {
    gatewayWithoutCors = new TdaiGateway({
      server: { port: PORT_NO_CORS, host: "127.0.0.1", corsOrigins: [] },
    } as never);
    await gatewayWithoutCors.start();

    gatewayWithCors = new TdaiGateway({
      server: { port: PORT_WITH_CORS, host: "127.0.0.1", corsOrigins: ["https://example.com"] },
    } as never);
    await gatewayWithCors.start();
  });

  afterAll(async () => {
    await gatewayWithCors.stop();
    await gatewayWithoutCors.stop();
  });

  it("does NOT emit Access-Control-Allow-Origin by default", async () => {
    const res = await request(PORT_NO_CORS, "/health");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-headers"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
  });

  it("does NOT respond 204 to OPTIONS preflight when CORS is disabled", async () => {
    const res = await request(PORT_NO_CORS, "/recall", {}, "OPTIONS");
    // With CORS disabled, OPTIONS falls through to normal routing
    // (404 because OPTIONS /recall is not a defined route), NOT a 204
    // preflight ack. This prevents OPTIONS from being a permanent
    // unauthenticated probe of the daemon's existence.
    expect(res.status).not.toBe(204);
  });

  it("emits Access-Control-Allow-Origin for an allowed origin", async () => {
    const res = await request(PORT_WITH_CORS, "/health", { Origin: "https://example.com" });
    expect(res.headers["access-control-allow-origin"]).toBe("https://example.com");
  });

  it("returns 204 for OPTIONS preflight when CORS is enabled", async () => {
    const res = await request(PORT_WITH_CORS, "/recall", { Origin: "https://example.com" }, "OPTIONS");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://example.com");
  });
});

describe("Gateway Host header allowlist (defence against DNS rebinding)", () => {
  let gateway: TdaiGateway;
  const PORT = 18432;

  beforeAll(async () => {
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
    } as never);
    await gateway.start();
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it.each([
    "127.0.0.1",
    "127.0.0.1:8421",
    "localhost",
    "localhost:8421",
    "[::1]",
    "[::1]:8421",
  ])("accepts loopback Host: %s", async (hostHeader) => {
    const res = await request(PORT, "/health", { Host: hostHeader });
    expect(res.status, `Host=${hostHeader}`).toBe(200);
  });

  it.each([
    "evil.com",
    "evil.com:8421",
    "10.0.0.1",
    "example.com",
    "127.0.0.1.evil.com",
    "localhost.evil.com",
  ])("rejects non-loopback Host: %s with 403", async (hostHeader) => {
    const res = await request(PORT, "/health", { Host: hostHeader });
    expect(res.status, `Host=${hostHeader}`).toBe(403);
  });

  it("skips Host check when TDAI_GATEWAY_ALLOW_REMOTE=1", async () => {
    vi.stubEnv("TDAI_GATEWAY_ALLOW_REMOTE", "1");
    const res = await request(PORT, "/health", { Host: "evil.com" });
    expect(res.status).toBe(200);
  });
});
