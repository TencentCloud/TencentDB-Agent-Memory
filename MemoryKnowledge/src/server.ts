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
import { acquireKnowledgeStoreOwnership } from "./data-root-ownership.js";
import { createWikiRoutes } from "./routes/wiki.js";
import { createCodeGraphRoutes } from "./routes/code-graph.js";
import { createToolsRoutes } from "./routes/tools.js";
import { createHealthRoutes } from "./routes/health.js";
import { createLlmBindingRoutes } from "./routes/llm-binding.js";
import { createAutoSyncRoutes } from "./routes/auto-sync.js";
import { accessLog } from "./middleware/response-envelope.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createServiceAuthMiddleware } from "./middleware/auth.js";
import { createLogger } from "./logger.js";
import {
  createKnowledgeTelemetry,
  createKnowledgeTelemetryMiddleware,
} from "./clickhouse-telemetry.js";
import { createAnalyticsRoutes } from "./analytics-routes.js";

const log = createLogger("server");

export function createApp() {
  const config = loadConfig();
  const knowledgeTelemetry = createKnowledgeTelemetry(config.clickhouse);

  // Acquire before metadata migration and especially before startup recovery.
  // A second process must never classify this process's active build as crashed.
  const dataRootOwnership = acquireKnowledgeStoreOwnership(config.dataDir, config.dbPath);
  let connection: ReturnType<typeof createDb> | undefined;
  let knowledgeModule: ReturnType<typeof createKnowledgeModule>;
  try {
    connection = createDb({ path: config.dbPath });
    knowledgeModule = createKnowledgeModule({
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      db: connection.db,
      dataRootOwnership,
      llmConfig: config.llm,
      tmcCallbackUrl: config.tmcCallbackUrl,
    });
  } catch (err) {
    connection?.raw.close();
    dataRootOwnership.release();
    throw err;
  }

  // Hono app
  const app = new Hono();

  // Middleware
  app.use("*", accessLog());
  app.onError(errorHandler);

  // Health (no prefix)
  app.route("/", createHealthRoutes());

  // /v3 prefix applied once here — routes define paths without prefix
  const api = new Hono();
  // 服务间鉴权：serviceKey 非空时，除只读白名单外的 /v3 端点均需
  // Bearer 鉴权（fail-closed）；key 为空则全放行（向后兼容）。
  // /health、/docs、/openapi.json 挂在 api 之外，保持开放。
  api.use("*", createServiceAuthMiddleware(config.auth, config.apiPrefix));
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

  // analytics — CH telemetry query endpoints (Panel dashboard)
  api.route("/analytics", createAnalyticsRoutes({
    clickhouse: config.clickhouse,
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
  const { app, config, knowledgeModule, knowledgeTelemetry } = createApp();
  try { await knowledgeTelemetry.initialize(); }
  catch (err) {
    knowledgeModule.autoSyncScheduler.stop();
    knowledgeModule.dataRootOwnership.release();
    throw err;
  }

  log.info(`Starting knowledge service on port ${config.port}`);
  log.info(`Data dir: ${config.dataDir}`);
  log.info(`DB path: ${config.dbPath}`);
  log.info(`API prefix: ${config.apiPrefix}`);
  log.info(`ClickHouse telemetry: ${config.clickhouse.enabled ? "enabled" : "disabled"}`);
  // Security posture：空 key 只 warn 不拒启（向后兼容），与 Core gateway 的默认开放语义一致。
  if (config.auth.serviceKey) {
    log.info("Service auth: enabled (KNOWLEDGE_SERVICE_KEY) — write/admin endpoints require Bearer");
  } else {
    log.warn(
      "Service auth: DISABLED — KNOWLEDGE_SERVICE_KEY is empty, all /v3 endpoints are open. " +
        "Set it for any shared or production deployment.",
    );
  }

  let server: ReturnType<typeof serve>;
  try {
    server = serve({ fetch: app.fetch, port: config.port }, (info) => {
      log.info(`Knowledge service listening on http://localhost:${info.port}`);
    });
  } catch (err) {
    knowledgeModule.autoSyncScheduler.stop();
    knowledgeModule.dataRootOwnership.release();
    throw err;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);
    knowledgeModule.autoSyncScheduler.stop();
    try { await knowledgeTelemetry.shutdown(); }
    catch (err) { log.warn(`Telemetry shutdown failed: ${String(err)}`); }
    server.close(() => {
      knowledgeModule.dataRootOwnership.release();
      process.exit(0);
    });
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
