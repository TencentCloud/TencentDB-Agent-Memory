/**
 * Tests for the MCP streamable-HTTP server (mcp/http-server.ts).
 *
 * Uses an in-process Hono app with createMcpHttpRoutes and exercises the
 * auth gate and session lifecycle via raw fetch calls.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createMcpHttpRoutes } from "../src/mcp/http-server.js";

const TEST_PORT = 18424;
const TEST_TOKEN = "test-mcp-token";

function baseUrl() {
  return `http://127.0.0.1:${TEST_PORT}`;
}

/** Build a minimal JSON-RPC initialize request body. */
function initBody() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  };
}

describe("createMcpHttpRoutes", () => {
  // ── No-auth instance ────────────────────────────────────────────────────────
  describe("without auth token", () => {
    let srv: Server;

    beforeAll(async () => {
      const app = new Hono();
      app.route("/mcp", createMcpHttpRoutes({
        httpOpts: { baseUrl: baseUrl() },
        // no authToken → auth disabled
      }));
      srv = serve({ fetch: app.fetch, port: TEST_PORT });
      await new Promise<void>((r) => srv.once("listening", r));
    });

    afterAll(() => new Promise<void>((r) => srv.close(() => r())));

    it("accepts initialize without Authorization header", async () => {
      const res = await fetch(`${baseUrl()}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initBody()),
      });
      // Transport writes directly to the socket; status may be 200 or the
      // raw JSON-RPC response — either way it must not be 401.
      expect(res.status).not.toBe(401);
    });
  });

  // ── Auth instance ───────────────────────────────────────────────────────────
  describe("with auth token", () => {
    let srv: Server;

    beforeAll(async () => {
      const app = new Hono();
      app.route("/mcp", createMcpHttpRoutes({
        httpOpts: { baseUrl: baseUrl() },
        authToken: TEST_TOKEN,
      }));
      srv = serve({ fetch: app.fetch, port: TEST_PORT + 1 });
      await new Promise<void>((r) => srv.once("listening", r));
    });

    afterAll(() => new Promise<void>((r) => srv.close(() => r())));

    it("rejects requests without Authorization header", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT + 1}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initBody()),
      });
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT + 1}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify(initBody()),
      });
      expect(res.status).toBe(401);
    });

    it("accepts requests with correct token", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT + 1}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(initBody()),
      });
      expect(res.status).not.toBe(401);
    });
  });
});
