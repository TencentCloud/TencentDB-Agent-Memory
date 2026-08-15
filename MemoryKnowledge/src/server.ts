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
import { createAutoSyncRoutes } from "./routes/auto-sync.js";
import { accessLog } from "./middleware/response-envelope.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createLogger } from "./logger.js";
import {
  createKnowledgeTelemetry,
  createKnowledgeTelemetryMiddleware,
} from "./clickhouse-telemetry.js";

const log = createLogger("server");

export function createApp() {
  const config = loadConfig();
  const knowledgeTelemetry = createKnowledgeTelemetry(config.clickhouse);

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
  // Only Agent tool executions are usage telemetry; health/admin/ingest remain excluded.
  api.use("/tools/call", createKnowledgeTelemetryMiddleware(knowledgeTelemetry));
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

  // auto-sync admin — 定时同步调度器状态查询 + 手动触发
  api.route("/", createAutoSyncRoutes({
    scheduler: knowledgeModule.autoSyncScheduler,
    config: knowledgeModule.autoSyncConfig,
  }));

  app.route(config.apiPrefix, api);

  // Swagger UI — serve OpenAPI spec from the package root (kept out of docs/
  // so the runtime never depends on documentation files).
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const openapiPath = join(currentDir, "..", "openapi.yaml");
  try {
    const openapiContent = readFileSync(openapiPath, "utf-8");
    app.get("/openapi.json", (c) => {
      return c.body(openapiContent, 200, { "Content-Type": "application/yaml" });
    });
    app.use("/docs", swaggerUI({ url: "/openapi.json" }));
    log.info("Swagger UI mounted at /docs");
  } catch {
    log.warn("OpenAPI spec not found at openapi.yaml, skipping Swagger UI");
  }

  return { app, config, knowledgeModule, knowledgeTelemetry };
}

async function startServer(): Promise<void> {
  const { app, config, knowledgeTelemetry } = createApp();
  await knowledgeTelemetry.initialize();

  log.info(`Starting knowledge service on port ${config.port}`);
  log.info(`Data dir: ${config.dataDir}`);
  log.info(`DB path: ${config.dbPath}`);
  log.info(`API prefix: ${config.apiPrefix}`);
  log.info(`ClickHouse telemetry: ${config.clickhouse.enabled ? "enabled" : "disabled"}`);

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info(`Knowledge service listening on http://localhost:${info.port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);
    await knowledgeTelemetry.shutdown();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

// Start server when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  void startServer().catch((err) => {
    log.error("Knowledge service failed to start", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  });
}
