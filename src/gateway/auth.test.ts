import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TdaiGateway } from "./server.js";

async function request(params: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; body: string; wwwAuth?: string }> {
  return new Promise((resolve, reject) => {
    const body = params.body === undefined ? "" : JSON.stringify(params.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: params.port,
        path: params.path,
        method: params.method ?? "GET",
        headers: {
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() } : {}),
          ...(params.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          wwwAuth: res.headers["www-authenticate"] as string | undefined,
        }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("Gateway bearer auth", () => {
  const port = 18451;
  const token = "test-token-abc-123";
  let gateway: TdaiGateway;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gateway-auth-"));
    vi.stubEnv("TDAI_DATA_DIR", tmpDir);
    vi.stubEnv("TDAI_GATEWAY_TOKEN", token);
    vi.stubEnv("TDAI_TOKEN_PATH", "");
    gateway = new TdaiGateway({ server: { port, host: "127.0.0.1" } } as never);
    await gateway.start();
  });

  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", token);
    vi.stubEnv("TDAI_TOKEN_PATH", "");
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("requires the bearer token when a token is configured", async () => {
    const missing = await request({ port, path: "/health" });
    expect(missing.status).toBe(401);
    expect(missing.wwwAuth).toMatch(/^Bearer\s+realm=/);

    const wrong = await request({ port, path: "/health", headers: { Authorization: "Bearer wrong" } });
    expect(wrong.status).toBe(401);

    const ok = await request({ port, path: "/health", headers: { Authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
  });

  it("requires bearer auth across all POST endpoints", async () => {
    const endpoints = [
      "/recall",
      "/capture",
      "/search/memories",
      "/search/conversations",
      "/session/end",
      "/seed",
    ];

    for (const path of endpoints) {
      const missing = await request({ port, path, method: "POST", body: {} });
      expect(missing.status, `${path} missing token`).toBe(401);

      const wrong = await request({
        port,
        path,
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: {},
      });
      expect(wrong.status, `${path} wrong token`).toBe(401);

      const authorized = await request({
        port,
        path,
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: {},
      });
      expect(authorized.status, `${path} valid token`).not.toBe(401);
    }
  });

  it("accepts RFC 6750 bearer scheme case variants", async () => {
    for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
      const result = await request({
        port,
        path: "/health",
        headers: { Authorization: `${scheme} ${token}` },
      });
      expect(result.status, scheme).toBe(200);
    }
  });

  it("rejects malformed authorization headers", async () => {
    const headers = [
      "Basic dGVzdA==",
      "",
      "Bearer",
      "Bearer wrong",
      `Bearer ${token} trailing`,
      `prefix Bearer ${token}`,
      `${token}`,
    ];

    for (const authorization of headers) {
      const result = await request({
        port,
        path: "/health",
        headers: authorization ? { Authorization: authorization } : {},
      });
      expect(result.status, authorization || "(empty)").toBe(401);
      expect(result.wwwAuth).toMatch(/^Bearer\s+realm=/);
    }
  });

  it("rejects non-loopback CORS origins before route handling", async () => {
    const result = await request({
      port,
      path: "/seed",
      method: "OPTIONS",
      headers: { Origin: "https://example.invalid" },
    });
    expect(result.status).toBe(403);
  });

  it("allows RFC loopback CORS origins", async () => {
    const result = await request({
      port,
      path: "/seed",
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.2:3000" },
    });
    expect(result.status).toBe(204);
  });

  it("rejects oversized JSON bodies with 413", async () => {
    const previousMaxBody = process.env.TDAI_GATEWAY_MAX_JSON_BODY_BYTES;
    vi.stubEnv("TDAI_GATEWAY_MAX_JSON_BODY_BYTES", "64");
    try {
      const result = await request({
        port,
        path: "/seed",
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: { data: "x".repeat(128) },
      });
      expect(result.status).toBe(413);
    } finally {
      vi.stubEnv("TDAI_GATEWAY_MAX_JSON_BODY_BYTES", previousMaxBody ?? "");
    }
  });
});

describe("Gateway loopback compatibility without a token", () => {
  const port = 18452;
  let gateway: TdaiGateway;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gateway-auth-none-"));
    vi.stubEnv("TDAI_DATA_DIR", tmpDir);
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", "");
    gateway = new TdaiGateway({ server: { port, host: "127.0.0.1" } } as never);
    await gateway.start();
  });

  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", "");
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preserves tokenless loopback health checks when no token is configured", async () => {
    const result = await request({ port, path: "/health" });
    expect(result.status).toBe(200);
  });

  it("requires a token for tokenless loopback POST routes by default", async () => {
    const result = await request({
      port,
      path: "/search/memories",
      method: "POST",
      body: {},
    });
    expect(result.status).toBe(401);
    expect(result.wwwAuth).toMatch(/^Bearer\s+realm=/);
  });
});

describe("Gateway explicit tokenless loopback development mode", () => {
  const port = 18456;
  let gateway: TdaiGateway;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gateway-auth-disabled-"));
    vi.stubEnv("TDAI_DATA_DIR", tmpDir);
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", "");
    vi.stubEnv("TDAI_GATEWAY_AUTH_DISABLED", "true");
    gateway = new TdaiGateway({ server: { port, host: "127.0.0.1" } } as never);
    await gateway.start();
  });

  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", "");
    vi.stubEnv("TDAI_GATEWAY_AUTH_DISABLED", "true");
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows POST routes only when explicitly disabled on loopback", async () => {
    const result = await request({
      port,
      path: "/search/memories",
      method: "POST",
      body: {},
    });
    expect(result.status).toBe(400);
    expect(result.body).toContain("Missing required field: query");
  });
});

describe("Gateway token file safety", () => {
  const port = 18453;
  let gateway: TdaiGateway;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gateway-auth-missing-"));
    vi.stubEnv("TDAI_DATA_DIR", tmpDir);
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", path.join(tmpDir, "missing-token"));
    gateway = new TdaiGateway({ server: { port, host: "127.0.0.1" } } as never);
    await gateway.start();
  });

  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", path.join(tmpDir, "missing-token"));
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not silently downgrade to tokenless mode when TDAI_TOKEN_PATH is configured but unreadable", async () => {
    const result = await request({ port, path: "/health" });
    expect(result.status).toBe(401);
  });
});

describe("Gateway empty token file safety", () => {
  const port = 18455;
  let gateway: TdaiGateway;
  let tmpDir: string;
  let tokenPath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gateway-auth-empty-"));
    tokenPath = path.join(tmpDir, "empty-token");
    fs.writeFileSync(tokenPath, "", { mode: 0o600 });
    vi.stubEnv("TDAI_DATA_DIR", tmpDir);
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", tokenPath);
    gateway = new TdaiGateway({ server: { port, host: "127.0.0.1" } } as never);
    await gateway.start();
  });

  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", tokenPath);
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not silently downgrade to tokenless mode when TDAI_TOKEN_PATH is empty", async () => {
    const result = await request({ port, path: "/health" });
    expect(result.status).toBe(401);
  });
});

describe("Gateway non-loopback tokenless safety", () => {
  const port = 18454;
  let gateway: TdaiGateway;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gateway-auth-remote-"));
    vi.stubEnv("TDAI_DATA_DIR", tmpDir);
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", "");
    vi.stubEnv("TDAI_GATEWAY_AUTH_DISABLED", "true");
    gateway = new TdaiGateway({ server: { port, host: "0.0.0.0" } } as never);
    await gateway.start();
  });

  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", "");
    vi.stubEnv("TDAI_GATEWAY_AUTH_DISABLED", "true");
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects tokenless non-loopback access even when auth-disabled is set", async () => {
    const result = await request({ port, path: "/health" });
    expect(result.status).toBe(401);
  });
});

describe("Gateway POST rate limiting", () => {
  const port = 18457;
  let gateway: TdaiGateway;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gateway-rate-limit-"));
    vi.stubEnv("TDAI_DATA_DIR", tmpDir);
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", "");
    vi.stubEnv("TDAI_GATEWAY_AUTH_DISABLED", "true");
    vi.stubEnv("TDAI_GATEWAY_POST_RATE_LIMIT_PER_MINUTE", "1");
    gateway = new TdaiGateway({ server: { port, host: "127.0.0.1" } } as never);
    await gateway.start();
  });

  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_TOKEN_PATH", "");
    vi.stubEnv("TDAI_GATEWAY_AUTH_DISABLED", "true");
    vi.stubEnv("TDAI_GATEWAY_POST_RATE_LIMIT_PER_MINUTE", "1");
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TDAI_GATEWAY_POST_RATE_LIMIT_PER_MINUTE;
  });

  it("returns 429 after the configured per-minute POST limit is exceeded", async () => {
    const first = await request({
      port,
      path: "/search/memories",
      method: "POST",
      body: {},
    });
    expect(first.status).toBe(400);

    const second = await request({
      port,
      path: "/search/memories",
      method: "POST",
      body: {},
    });
    expect(second.status).toBe(429);
    expect(second.body).toContain("Too many POST requests");
  });
});
