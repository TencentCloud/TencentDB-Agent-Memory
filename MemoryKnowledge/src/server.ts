/**
 * Hono HTTP server entry point.
 *
 * Mounts all routes under /v3 prefix (applied once here, not per-route).
 * Health check at /health (no prefix).
 * Swagger UI at /docs.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { bodyLimit } from "hono/body-limit";
import { swaggerUI } from "@hono/swagger-ui";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { initTelemetry, shutdownTelemetry } from "./telemetry.js";

import {
  loadConfig,
  validateListenerConfig,
  isLoopbackHost,
  normalizeAndValidateApiPrefix,
  type ServiceConfig,
} from "./config.js";
import { createDb } from "./db/client.js";
import { createKnowledgeModule } from "./module.js";
import { createWikiRoutes } from "./routes/wiki.js";
import { createCodeGraphRoutes } from "./routes/code-graph.js";
import { createToolsRoutes } from "./routes/tools.js";
import { createHealthRoutes } from "./routes/health.js";
import { createLlmBindingRoutes } from "./routes/llm-binding.js";
import { createAutoSyncRoutes } from "./routes/auto-sync.js";
import { createSourceCredentialRoutes } from "./routes/source-credential.js";
import { createSourceProviderRoutes } from "./routes/source-provider.js";
import { createWikiSourceRoutes } from "./wiki-source/routes.js";
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

export interface AppInstance {
  app: Hono;
  config: ServiceConfig;
  knowledgeModule: ReturnType<typeof createKnowledgeModule>;
  knowledgeTelemetry: ReturnType<typeof createKnowledgeTelemetry>;
  db: ReturnType<typeof createDb>["db"];
  rawDb: ReturnType<typeof createDb>["raw"];
  close: () => void;
}

export function createApp(explicitConfig?: ServiceConfig | Partial<ServiceConfig>): AppInstance {
  const baseConfig = loadConfig();
  const config: ServiceConfig = explicitConfig
    ? {
        ...baseConfig,
        ...explicitConfig,
        apiPrefix: explicitConfig.apiPrefix !== undefined
          ? normalizeAndValidateApiPrefix(explicitConfig.apiPrefix)
          : baseConfig.apiPrefix,
        auth: { ...baseConfig.auth, ...(explicitConfig.auth ?? {}) },
        clickhouse: { ...baseConfig.clickhouse, ...(explicitConfig.clickhouse ?? {}) },
        llm: { ...baseConfig.llm, ...(explicitConfig.llm ?? {}) },
      }
    : baseConfig;
  const knowledgeTelemetry = createKnowledgeTelemetry(config.clickhouse);

  const { db, raw } = createDb({ path: config.dbPath });
  const knowledgeModule = createKnowledgeModule({
    dataDir: config.dataDir,
    db,
    llmConfig: config.llm,
    tmcCallbackUrl: config.tmcCallbackUrl,
  });

  // Hono app
  const app = new Hono();

  // Health (no prefix, public)
  app.route("/", createHealthRoutes());

  // Service-to-service auth: reject unauthenticated requests BEFORE
  // body reading, logging, OKF body limit, or telemetry.
  const authMiddleware = createServiceAuthMiddleware(config.auth, config.apiPrefix);
  app.use(config.apiPrefix, authMiddleware);
  app.use(`${config.apiPrefix}/*`, authMiddleware);

  // Middleware (applied only to authenticated or open requests)
  app.use(`${config.apiPrefix}/wiki/okf/*`, bodyLimit({
    maxSize: 20 * 1024 * 1024,
    onError: (c) => c.json({ code: 413, message: "payload too large", data: null }, 413)
  }));
  app.use("*", accessLog());
  app.onError(errorHandler);

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

  // source-credential / source-provider — 外部知识源令牌 + 来源列表
  api.route("/source-credential", createSourceCredentialRoutes({
    credentialStore: knowledgeModule.credentialStore,
    store: knowledgeModule.store,
  }));
  api.route("/source-provider", createSourceProviderRoutes({
    registry: knowledgeModule.codeSourceRegistry,
    wikiRegistry: knowledgeModule.wikiSourceRegistry,
  }));

  // wiki-source — 外部 wiki 列文档 / 导入（不触发 ingest）
  api.route("/wiki-source", createWikiSourceRoutes({
    registry: knowledgeModule.wikiSourceRegistry,
    credentialStore: knowledgeModule.credentialStore,
    wikiService: knowledgeModule.wikiService,
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

  return {
    app,
    config,
    knowledgeModule,
    knowledgeTelemetry,
    db,
    rawDb: raw,
    close: () => {
      try {
        knowledgeModule.autoSyncScheduler.stop();
      } catch {}
      try {
        raw.close();
      } catch {}
    },
  };
}

export async function startServer(): Promise<void> {
  const config = loadConfig();
  // Validate listener posture before starting network/telemetry side effects
  validateListenerConfig(config);

  // Initialize tracing only after listener security posture validation
  initTelemetry();

  const { app, knowledgeTelemetry } = createApp(config);
  await knowledgeTelemetry.initialize();

  log.info(`Starting knowledge service on http://${config.host}:${config.port}`);
  log.info(`Data dir: ${config.dataDir}`);
  log.info(`DB path: ${config.dbPath}`);
  log.info(`API prefix: ${config.apiPrefix}`);
  log.info(`ClickHouse telemetry: ${config.clickhouse.enabled ? "enabled" : "disabled"}`);
  if (config.auth.serviceKey) {
    log.info("Service auth: enabled (KNOWLEDGE_SERVICE_KEY) — all service API endpoints require Bearer");
  } else if (isLoopbackHost(config.host)) {
    log.warn(
      "Service auth: DISABLED — KNOWLEDGE_SERVICE_KEY is empty. Permitted on loopback (127.0.0.1) for local development.",
    );
  } else {
    log.warn(
      "Service auth: DISABLED on non-loopback host via KNOWLEDGE_ALLOW_INSECURE_NO_KEY_LISTEN=true. " +
        "INSECURE POSTURE — do not use in production!",
    );
  }

  const server = serve(
    { fetch: app.fetch, port: config.port, hostname: config.host },
    (info) => {
      log.info(`Knowledge service listening on http://${config.host}:${info.port}`);
    },
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);
    await knowledgeTelemetry.shutdown();
    await shutdownTelemetry();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

function isDirectRun(metaUrl: string, argv1?: string): boolean {
  if (!argv1) return false;
  try {
    return fileURLToPath(metaUrl) === resolve(argv1);
  } catch {
    return false;
  }
}

// Start server when run directly
if (isDirectRun(import.meta.url, process.argv[1])) {
  void startServer().catch((err) => {
    log.error("Knowledge service failed to start", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  });
}
