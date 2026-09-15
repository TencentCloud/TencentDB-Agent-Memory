import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { TdaiGateway } from "./server.js";

describe("TdaiGateway security headers", () => {
  let gateway: TdaiGateway;
  let serverUrl: string;

  beforeAll(async () => {
    gateway = new TdaiGateway({
      server: {
        port: 0, // random available port
        host: "127.0.0.1",
        apiKey: "", // no auth for testing
        corsOrigins: [],
      },
    });
    await gateway.start();

    // Get the actual port
    const address = (gateway as any).server?.address();
    const port = typeof address === "object" ? address?.port : 0;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("should include X-Content-Type-Options header", async () => {
    const res = await fetch(`${serverUrl}/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("should include X-Frame-Options header", async () => {
    const res = await fetch(`${serverUrl}/health`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("should include X-XSS-Protection header", async () => {
    const res = await fetch(`${serverUrl}/health`);
    expect(res.headers.get("x-xss-protection")).toBe("1; mode=block");
  });

  it("should include Referrer-Policy header", async () => {
    const res = await fetch(`${serverUrl}/health`);
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("should include Permissions-Policy header", async () => {
    const res = await fetch(`${serverUrl}/health`);
    expect(res.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=()"
    );
  });

  it("should NOT include HSTS header on non-HTTPS connection", async () => {
    const res = await fetch(`${serverUrl}/health`);
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("should include all security headers on POST endpoints", async () => {
    const res = await fetch(`${serverUrl}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
