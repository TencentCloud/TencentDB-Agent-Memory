/**
 * dev-console / server — a build-free local console for exercising the TDAI
 * Gateway end to end and watching the memory pyramid build per account.
 *
 *   browser (single-page UI, same-origin)
 *        │
 *        ▼
 *   this console server (default :8421)
 *        ├─ proxies /api/gw/* → real Gateway (injects Bearer server-side)
 *        └─ GET /api/inspect  → reads account dataDir read-only (the pyramid)
 *
 * Proxying means the browser only ever talks to this server (same origin), so
 * the Gateway needs NO CORS config and its API key never reaches the client.
 *
 * Config is loaded with the SAME `loadGatewayConfig()` the Gateway uses, so the
 * console resolves the identical baseDir / multiTenant / apiKey / port — point
 * both at the same env and they automatically agree.
 *
 * Run:  npm run dev-console   (or: node --import tsx scripts/dev-console/server.ts)
 * Dev tool only — not bundled, not published, no auth of its own. Bind localhost.
 */

import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getEnv } from "../../src/utils/env.js";
import { loadGatewayConfig } from "../../src/gateway/config.js";
import { inspectAccount, listAccounts } from "./inspector.js";

const INDEX_HTML = fileURLToPath(new URL("./public/index.html", import.meta.url));

// Gateway routes the console is allowed to proxy to (closed allow-list).
const GW_POST_ROUTES = new Set([
  "/recall",
  "/capture",
  "/search/memories",
  "/search/conversations",
  "/session/end",
  "/namespace/wipe",
  "/seed",
]);

const cfg = loadGatewayConfig();
const baseDir = cfg.data.baseDir;
const multiTenant = cfg.data.multiTenant;
const apiKey = cfg.server.apiKey;

// Where the real Gateway lives. Default to the loopback form of the Gateway's
// own configured host:port; override with GATEWAY_URL for a remote/odd setup.
const gwHost = cfg.server.host === "0.0.0.0" ? "127.0.0.1" : cfg.server.host;
const gatewayUrl = (getEnv("GATEWAY_URL") ?? `http://${gwHost}:${cfg.server.port}`).replace(/\/$/, "");

const consolePort = Number(getEnv("DEV_CONSOLE_PORT") ?? "8421");
const consoleHost = getEnv("DEV_CONSOLE_HOST") ?? "127.0.0.1";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function authHeaders(): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Forward a console request to the Gateway, returning its status + raw text. */
async function proxyToGateway(
  method: "GET" | "POST",
  gwPath: string,
  body?: string,
): Promise<{ status: number; text: string; contentType: string }> {
  try {
    const res = await fetch(`${gatewayUrl}${gwPath}`, {
      method,
      headers: {
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(),
      },
      body: method === "POST" ? (body ?? "{}") : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, contentType: res.headers.get("content-type") ?? "application/json" };
  } catch (err) {
    return {
      status: 502,
      text: JSON.stringify({
        error: `Cannot reach Gateway at ${gatewayUrl}${gwPath}: ${String((err as Error)?.message ?? err)}`,
        hint: "Is the Gateway running? Set GATEWAY_URL if it is elsewhere.",
      }),
      contentType: "application/json",
    };
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // ── UI ────────────────────────────────────────────────────────────────
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = fs.readFileSync(INDEX_HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // ── console self-config (UI bootstraps mode/baseDir/gateway from this) ──
    if (method === "GET" && pathname === "/api/config") {
      sendJson(res, 200, { multiTenant, baseDir, gatewayUrl, hasApiKey: !!apiKey });
      return;
    }

    // ── account picker (read-only disk) — real on-disk accounts + counts ────
    if (method === "GET" && pathname === "/api/accounts") {
      try {
        sendJson(res, 200, { accounts: listAccounts(baseDir, multiTenant), multiTenant });
      } catch (err) {
        sendJson(res, 500, { error: String((err as Error)?.message ?? err) });
      }
      return;
    }

    // ── pyramid inspection (read-only disk) ────────────────────────────────
    if (method === "GET" && pathname === "/api/inspect") {
      const sessionKey = url.searchParams.get("session_key") ?? "";
      if (multiTenant && !sessionKey.trim()) {
        sendJson(res, 400, { error: "session_key is required in multi-tenant mode" });
        return;
      }
      try {
        sendJson(res, 200, inspectAccount(sessionKey, baseDir, multiTenant));
      } catch (err) {
        sendJson(res, 400, { error: String((err as Error)?.message ?? err) });
      }
      return;
    }

    // ── Gateway proxy ──────────────────────────────────────────────────────
    if (pathname === "/api/gw/health" && method === "GET") {
      const r = await proxyToGateway("GET", "/health");
      res.writeHead(r.status, { "Content-Type": r.contentType });
      res.end(r.text);
      return;
    }

    if (pathname.startsWith("/api/gw/") && method === "POST") {
      const gwPath = pathname.slice("/api/gw".length); // → "/recall", "/search/memories", ...
      if (!GW_POST_ROUTES.has(gwPath)) {
        sendJson(res, 404, { error: `Unknown gateway route: ${gwPath}` });
        return;
      }
      const body = await readBody(req);
      const r = await proxyToGateway("POST", gwPath, body);
      res.writeHead(r.status, { "Content-Type": r.contentType });
      res.end(r.text);
      return;
    }

    sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });
  } catch (err) {
    sendJson(res, 500, { error: String((err as Error)?.message ?? err) });
  }
});

server.listen(consolePort, consoleHost, () => {
  // eslint-disable-next-line no-console
  console.log(
    [
      `TDAI dev-console → http://${consoleHost}:${consolePort}`,
      `  gateway   : ${gatewayUrl}${apiKey ? " (Bearer auth on)" : ""}`,
      `  baseDir   : ${baseDir}`,
      `  multiTenant: ${multiTenant}`,
    ].join("\n"),
  );
});
