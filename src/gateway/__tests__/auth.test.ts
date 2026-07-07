import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";
import { TdaiGateway } from "../server.js";

async function request(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; body: string; wwwAuth: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            wwwAuth: res.headers["www-authenticate"] as string | undefined,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Gateway optional Bearer token", () => {
  let gateway: TdaiGateway;
  const PORT = 18421;
  const TOKEN = "test-token-abc-123";

  beforeAll(async () => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1", corsOrigins: ["https://example.com"] },
    } as never);
    await gateway.start();
  });

  // vitest config has `unstubEnvs: true`, which resets stubs before each test.
  // Re-stub here so the middleware (which reads process.env per-request) sees the token.
  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("rejects unauthenticated requests with 401 when token is configured", async () => {
    const res = await request(PORT, "/health");
    expect(res.status).toBe(401);
  });

  it("rejects wrong token with 401", async () => {
    const res = await request(PORT, "/health", {
      Authorization: "Bearer wrong-token",
    });
    expect(res.status).toBe(401);
  });

  it("accepts correct Bearer token", async () => {
    const res = await request(PORT, "/health", {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
  });

  it("includes WWW-Authenticate header on 401 per RFC 6750 §3", async () => {
    const res = await request(PORT, "/health");
    expect(res.status).toBe(401);
    expect(res.wwwAuth).toMatch(/^Bearer\s+realm=/);
  });

  it("accepts case-insensitive 'Bearer' scheme keyword per RFC 6750 §2.1", async () => {
    for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
      const res = await request(PORT, "/health", {
        Authorization: `${scheme} ${TOKEN}`,
      });
      expect(res.status, `scheme=${scheme}`).toBe(200);
    }
  });

  it("rejects mangled Authorization headers", async () => {
    const cases = [
      `Basic ${TOKEN}`,
      `Bearer`,
      `Bearer `,
      `Bearer  ${TOKEN}  extra`,
      ``,
      `Bearer ${TOKEN}x`,
      `Bearer x${TOKEN}`,
    ];
    for (const h of cases) {
      const res = await request(PORT, "/health", { Authorization: h });
      expect(res.status, `auth=${JSON.stringify(h)}`).toBe(401);
    }
  });

  it.each([
    ["POST", "/recall"],
    ["POST", "/capture"],
    ["POST", "/search/memories"],
    ["POST", "/search/conversations"],
    ["POST", "/session/end"],
    ["POST", "/seed"],
  ])("enforces auth on %s %s (no token → 401)", async (method, path) => {
    const res = await request(PORT, path, {}, method);
    expect(res.status).toBe(401);
  });

  it("allows OPTIONS preflight without token (CORS)", async () => {
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: "/recall",
          method: "OPTIONS",
          headers: { Origin: "https://example.com" },
        },
        (res) => {
          expect(res.statusCode).toBe(204);
          resolve();
        },
      );
      req.on("error", reject);
      req.end();
    });
  });
});

describe("Gateway with no token configured", () => {
  let gateway: TdaiGateway;
  const PORT = 18422;

  beforeAll(async () => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
    } as never);
    await gateway.start();
  });

  // vitest config has `unstubEnvs: true`; re-stub each test so middleware sees empty token.
  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("accepts unauthenticated requests when token is empty (backward compat)", async () => {
    const res = await request(PORT, "/health");
    expect(res.status).toBe(200);
  });
});
