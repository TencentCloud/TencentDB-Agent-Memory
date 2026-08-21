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
import {
  setExtensionDebug,
  shutdownGuard,
  shutdownPrivateControlPlane,
  startPrivateControlPlane,
} from "./guard-adapter.js";
import {
  initRequestPrepare,
  isRequestPrepareActive,
  isRequestPrepareEnabledByDefault,
  shutdownRequestPrepare,
} from "./request-prepare-adapter.js";
import { initLogger, shutdownLogger, log } from "./report/log.js";
import { initClickHouse, shutdownClickHouse } from "./clickhouse.js";
import { initLangfuse, shutdownLangfuse } from "./langfuse.js";
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

// Enable extension debug logging if log.level === "debug"
setExtensionDebug(config.log.level === "debug");

// ── Initialize ClickHouse writer ─────────────────────────────────────────────
initClickHouse(config.clickhouse);

// ── Initialize Langfuse tracing (official SDK) ───────────────────────────────
initLangfuse(config).catch((err: unknown) => {
  log.warn("langfuse.init_error", { error: String(err) });
});

// ── Initialize auth client (user_key verification + user_id resolution) ──────
initAuth(config.auth);

// ── Register internal service accounts (bypass whole pipeline on match) ──────
initSystemUsers(config.systemUsers);

// ── Initialize ProxyStorage (dynamic import cost-guard for kernel-sts COS) ──
// 必须 await —— dynamic import 是 async 的；不 await 直接进 createApp 会
// 让首个 cos 请求 fallback 到 sqlite（backend 已经拿到但 _kernelStsFactory null）
await initProxyStorage(config.storage);
const effectiveStorage = getEffectiveBackend();
if (config.storage.enabled && config.storage.backend === "cos" && effectiveStorage.effective !== "cos") {
  log.warn("storage.degraded", {
    requested: effectiveStorage.requested,
    effective: effectiveStorage.effective,
    reason: effectiveStorage.error,
    note: "cost-guard submodule missing or shark unreachable — cos falling back",
  });
}

// ── Start private control plane (optional, same process / separate port) ────
try {
  if (await startPrivateControlPlane(config)) {
    log.info("private_control_plane.enabled");
  }
} catch (err: unknown) {
  // A management-plane outage must not prevent the LLM data plane from starting.
  log.warn("private_control_plane.start_failed", { error: String(err) });
}

// ── Bring up the optional request-preparation stage ─────────────────────────
// Opaque to the host: it only owns the resource lifecycle, never the behavior.
if (isRequestPrepareActive(config)) {
  if (!config.redis.enabled) {
    // The stage keeps its cross-request state in Redis. Without it every
    // request starts cold — correct, but it gives up the shared cache.
    log.warn("request_prepare.no_redis", {
      note: "costGuard.requestPrepare is configured but redis.enabled=false — running uncached",
    });
  }
  initRequestPrepare(config);
  log.info("request_prepare.enabled", {
    redis: config.redis.enabled,
    // False means the stage is wired but idle until the control plane enables
    // it for a space, so an empty compression log is expected rather than a bug.
    enabledByDefault: isRequestPrepareEnabledByDefault(config),
  });
}

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
  costGuard: config.costGuard.enabled ? "enabled" : "disabled",
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
  await shutdownGuard();
  await shutdownPrivateControlPlane();
  await shutdownRequestPrepare();
  await shutdownLangfuse();
  await shutdownClickHouse();
  await shutdownLogger();
  process.exit(0);
}

process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
