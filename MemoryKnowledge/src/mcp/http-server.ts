/**
 * MCP Streamable-HTTP server — exposes knowledge query tools over HTTP.
 *
 * Complements the stdio server (server.ts) by providing a network-accessible
 * MCP endpoint that remote agents can connect to via URL + Bearer token,
 * the same way they connect to any standard MCP streamable-HTTP server.
 *
 * Mount point: /mcp on the knowledge service Hono app.
 *
 * Auth: when KNOWLEDGE_MCP_AUTH_TOKEN is set, every request must carry
 * `Authorization: Bearer <token>`. Leave unset for local/dev use (no auth).
 *
 * Session model: one Server + StreamableHTTPServerTransport per client
 * session, keyed by the `mcp-session-id` header the SDK manages automatically.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Hono } from "hono";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { createMcpServer } from "./server.js";
import type { HttpClientOptions } from "./http-client.js";
import { createLogger } from "../logger.js";

const log = createLogger("mcp-http");

export interface McpHttpServerOptions {
  /** Options forwarded to the underlying knowledge API HTTP client. */
  httpOpts: HttpClientOptions;
  /**
   * Bearer token required on every MCP request.
   * Empty string (default) disables auth — suitable for local/dev use only.
   */
  authToken?: string;
}

interface Session {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

/**
 * Build a Hono sub-app that speaks MCP Streamable-HTTP at its root path.
 *
 * Mount it in the main server:
 * ```ts
 * app.route("/mcp", createMcpHttpRoutes({ httpOpts, authToken }));
 * ```
 *
 * Agents then connect to `https://<host>:<port>/mcp` with
 * `Authorization: Bearer <token>` (when authToken is configured).
 */
export function createMcpHttpRoutes(opts: McpHttpServerOptions): Hono {
  const { httpOpts, authToken = "" } = opts;
  const sessions = new Map<string, Session>();

  const app = new Hono();

  // ── Auth gate ──────────────────────────────────────────────────────────────
  app.use("*", async (c, next) => {
    if (!authToken) return next();
    const header = c.req.header("Authorization") ?? "";
    if (header !== `Bearer ${authToken}`) {
      log.warn(`MCP auth rejected: bad or missing Authorization header`);
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }, 401);
    }
    return next();
  });

  // ── POST — JSON-RPC requests (initialize, tools/list, tools/call, …) ───────
  app.post("/", async (c) => {
    const incoming = c.env.incoming as IncomingMessage;
    const outgoing = c.env.outgoing as ServerResponse;
    const sessionId = c.req.header("mcp-session-id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      outgoing.writeHead(400, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
      return c.body(null);
    }

    if (!sessionId) {
      // No session yet → this must be an initialize request; spin up a new session.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { server, transport });
          log.info(`MCP session opened: ${sid}`);
        },
        onsessionclosed: (sid) => {
          sessions.delete(sid);
          log.info(`MCP session closed: ${sid}`);
        },
      });
      const server = createMcpServer(httpOpts);
      await server.connect(transport);
      await transport.handleRequest(incoming, outgoing, body);
    } else {
      const session = sessions.get(sessionId);
      if (!session) {
        log.warn(`MCP request for unknown session: ${sessionId}`);
        outgoing.writeHead(404, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return c.body(null);
      }
      await session.transport.handleRequest(incoming, outgoing, body);
    }

    // Transport wrote directly to `outgoing`; prevent Hono from sending again.
    return c.body(null);
  });

  // ── GET — SSE stream for server-initiated messages ─────────────────────────
  app.get("/", async (c) => {
    const incoming = c.env.incoming as IncomingMessage;
    const outgoing = c.env.outgoing as ServerResponse;
    const sessionId = c.req.header("mcp-session-id");

    if (!sessionId) {
      outgoing.writeHead(400, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "Missing mcp-session-id header" }));
      return c.body(null);
    }

    const session = sessions.get(sessionId);
    if (!session) {
      outgoing.writeHead(404, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "Session not found" }));
      return c.body(null);
    }

    await session.transport.handleRequest(incoming, outgoing);
    return c.body(null);
  });

  // ── DELETE — client-initiated session teardown ─────────────────────────────
  app.delete("/", async (c) => {
    const incoming = c.env.incoming as IncomingMessage;
    const outgoing = c.env.outgoing as ServerResponse;
    const sessionId = c.req.header("mcp-session-id");

    if (!sessionId) {
      outgoing.writeHead(400, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "Missing mcp-session-id header" }));
      return c.body(null);
    }

    const session = sessions.get(sessionId);
    if (!session) {
      outgoing.writeHead(404, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "Session not found" }));
      return c.body(null);
    }

    await session.transport.handleRequest(incoming, outgoing);
    return c.body(null);
  });

  return app;
}
