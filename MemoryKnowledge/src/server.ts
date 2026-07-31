/**
 * Hono HTTP server entry point.
 *
 * Mounts all routes under /v3 prefix (applied once here, not per-route).
 * Health check at /health (no prefix).
 * Swagger UI at /docs.
 */

// Telemetry must initialize before any module that may produce OpenTelemetry spans
import { initTelemetry } from "./telemetry.js";
initTelemetry();

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createKnowledgeModule } from "./module.js";
import { createWikiRoutes } from "./routes/wiki.js";
import { createCodeGraphRoutes } from "./routes/code-graph.js";
import { createToolsRoutes } from "./routes/tools.js";
import { createHealthRoutes } from "./routes/health.js";
import { createLlmBindingRoutes } from "./routes/llm-binding.js";
import { createMcpHttpRoutes } from "./mcp/http-server.js";
import { accessLog } from "./middleware/response-envelope.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createLogger } from "./logger.js";

const log = createLogger("server");

export function createApp() {
  const config = loadConfig();

  // Initialize DB + knowledge module
  const { db } = createDb({ path: config.dbPath });
  const knowledgeModule = createKnowledgeModule({
    dataDir: config.dataDir,
    db,
    llmConfig: config.llm,
    tmcCallbackUrl: config.tmcCallbackUrl,
  });

  // Hono app
  const app = new Hono();

  // Middleware
  app.use("*", accessLog());
  app.onError(errorHandler);

  // Health (no prefix)
  app.route("/", createHealthRoutes());

  // /v3 prefix applied once here — routes define paths without prefix
  const api = new Hono();
  api.route("/wiki", createWikiRoutes({
    wikiService: knowledgeModule.wikiService,
    wikiMgr: knowledgeModule.wikiMgr,
    publicBaseUrl: config.publicBaseUrl,
  }));
  api.route("/code-graph", createCodeGraphRoutes({
    cgService: knowledgeModule.cgService,
    instancePool: knowledgeModule.instancePool,
    publicBaseUrl: config.publicBaseUrl,
  }));

  // tools/list + tools/call — Agent self-discovery HTTP endpoints
  api.route("/tools", createToolsRoutes({
    wikiService: knowledgeModule.wikiService,
    wikiMgr: knowledgeModule.wikiMgr,
    cgService: knowledgeModule.cgService,
    instancePool: knowledgeModule.instancePool,
  }));

  // internal/* — control-plane endpoints (TMC / operator). Per-instance LLM routing.
  api.route("/internal/llm-binding", createLlmBindingRoutes({
    llmBindingStore: knowledgeModule.llmBindingStore,
  }));

  app.route(config.apiPrefix, api);

  // MCP streamable-HTTP endpoint — remote agents connect here via URL + Bearer token.
  // Auth: set KNOWLEDGE_MCP_AUTH_TOKEN to require Authorization: Bearer <token>.
  app.route("/mcp", createMcpHttpRoutes({
    httpOpts: {
      baseUrl: `http://127.0.0.1:${config.port}`,
      token: config.mcpAuthToken || undefined,
    },
    authToken: config.mcpAuthToken || undefined,
  }));
  log.info(`MCP streamable-HTTP endpoint mounted at /mcp (auth: ${config.mcpAuthToken ? "enabled" : "disabled"})`);

  // Swagger UI — serve OpenAPI spec from docs/api/openapi.yaml
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const openapiPath = join(currentDir, "..", "docs", "api", "openapi.yaml");
  try {
    const openapiContent = readFileSync(openapiPath, "utf-8");
    app.get("/openapi.json", (c) => {
      return c.body(openapiContent, 200, { "Content-Type": "application/yaml" });
    });
    app.use("/docs", swaggerUI({ url: "/openapi.json" }));
    log.info("Swagger UI mounted at /docs");
  } catch {
    log.warn("OpenAPI spec not found at docs/api/openapi.yaml, skipping Swagger UI");
  }

  return { app, config, knowledgeModule };
}

// Start server when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, config } = createApp();

  log.info(`Starting knowledge service on port ${config.port}`);
  log.info(`Data dir: ${config.dataDir}`);
  log.info(`DB path: ${config.dbPath}`);
  log.info(`API prefix: ${config.apiPrefix}`);

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info(`Knowledge service listening on http://localhost:${info.port}`);
  });
}
