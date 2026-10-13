/** Entry point: parse config, start server. */

if (!process.version.startsWith("v22.")) {
  console.error(`\x1b[31m[ERROR] Node.js version check failed!\x1b[0m`);
  console.error(`\x1b[31m[ERROR] Required Node.js version: v22.x\x1b[0m`);
  console.error(`\x1b[31m[ERROR] Current Node.js version is: ${process.version}\x1b[0m`);
  console.error(`\x1b[33m[TIP] Please run with Node.js v22. You can switch using:\x1b[0m`);
  console.error(`\x1b[33m      source ~/.nvm/nvm.sh && nvm use 22\x1b[0m`);
  process.exit(1);
}

import { serve } from "@hono/node-server";
import { buildConfig, parseArgv } from "./config.js";
import { createApp } from "./server.js";


import { initLogger, shutdownLogger, log } from "./report/log.js";
import { initClickHouse, shutdownClickHouse } from "./clickhouse.js";
import { initLangfuse, shutdownLangfuse } from "./langfuse.js";
import { initTraceArchive, shutdownTraceArchive } from "./trace-archive.js";
import { initAuth } from "./auth.js";
import { initSystemUsers } from "./systemUser.js";
import { checkConnectivity } from "./connectivity.js";
import { initProxyStorage, getEffectiveBackend } from "./storage/factory.js";

import { flushPendingWrites, pendingWriteCount } from "./tdai/pending-writes.js";

const overrides = parseArgv(process.argv);
const config = buildConfig(overrides);

// ── Initialize structured logging system ─────────────────────────────────────
initLogger({
  level: config.log.level === "debug" ? "debug" : "info",
  filePath: config.log.file || "",
  rotate: config.log.rotate,
  backend: config.log.backend,
});

// ── Initialize ClickHouse writer ─────────────────────────────────────────────
initClickHouse(config.clickhouse);

// ── Initialize local JSONL trace archive (disabled by default) ───────────────
{
  const projectRoot = new URL("../", import.meta.url).pathname;
  initTraceArchive(projectRoot, config.traceArchive);
}

// ── Initialize Langfuse tracing (official SDK) ───────────────────────────────
initLangfuse(config).catch((err: unknown) => {
  log.warn("langfuse.init_error", { error: String(err) });
});

// ── Initialize auth client (user_key verification + user_id resolution) ──────
initAuth(config.auth);

// ── Register internal service accounts (bypass whole pipeline on match) ──────
initSystemUsers(config.systemUsers);

// Initialize local Proxy storage.
await initProxyStorage(config.storage);

const app = createApp(config);

log.info("server.starting", {
  host: config.server.host,
  port: config.server.port,
  upstream: config.upstream.url,
  logFile: config.log.file || "(disabled)",
  logLevel: config.log.level,
  opik: config.opik.enabled ? config.opik.url : "disabled",
  langfuse: config.langfuse.enabled ? config.langfuse.host : "disabled",
  clickhouse: config.clickhouse.enabled ? config.clickhouse.url : "disabled",

  rateLimit: config.rateLimit.tpm > 0 || config.rateLimit.qpm > 0
    ? `${config.rateLimit.tpm} TPM / ${config.rateLimit.qpm} QPM`
    : "disabled",
  sessionInit: config.sessionInit.enabled ? "enabled" : "disabled",
  injection: config.injection.enabled ? config.injection.injectors.join(",") : "disabled",
  tdai: config.tdai.enabled ? config.tdai.endpoint : "disabled",
  coreSkill: config.coreSkill.serviceToken ? config.coreSkill.endpoint : "disabled",
  skillRuntime: `allowLlmWrite=${config.skillRuntime.allowLlmWrite}`,
  auth: config.auth.enabled ? config.auth.url : "disabled",
  systemUsers: config.systemUsers.length > 0
    ? config.systemUsers.map((u) => u.name || "unnamed").join(",")
    : "disabled",
  traceArchive: config.traceArchive.enabled ? config.traceArchive.dir : "disabled",
});

serve(
  {
    fetch: app.fetch,
    hostname: config.server.host,
    port: config.server.port,
  },
  ({ address, port }) => {
    log.info("server.listening", { address, port });

    // ── Startup connectivity check (fire-and-forget, never blocks) ───────
    checkConnectivity(config).catch((err: unknown) => {
      log.warn("connectivity.check_error", { error: String(err) });
    });
  },
);

// ── Graceful shutdown ────────────────────────────────────────────────────────
// L0 flush 顺序放在最前：streaming 场景 recordTdaiTurn 是 fire-and-forget，
// pod rolling update 收到 SIGTERM 时 event loop 里可能还有 in-flight POST
// 未落到 tdai kernel。先等它们跑完（10s 兜底），再关闭 langfuse/clickhouse/log。
// k8s 默认 terminationGracePeriodSeconds=30s，10s 留出充足余量。
async function gracefulShutdown(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  log.info("server.shutdown", { signal });
  const pending = pendingWriteCount();
  if (pending > 0) {
    log.info("server.shutdown.flush_l0", { pending });
    const { drained, remaining } = await flushPendingWrites(10_000);
    log.info("server.shutdown.flush_l0.done", { drained, remaining });
  }


  await shutdownTraceArchive();
  await shutdownLangfuse();
  await shutdownClickHouse();
  await shutdownLogger();
  process.exit(0);
}

process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
