/**
 * Startup connectivity checker — probes all enabled external dependencies
 * and logs a unified connectivity report. Non-blocking, fire-and-forget.
 */

import { log } from "./report/log.js";
import type { ProxyConfig } from "./types.js";

const TIMEOUT = 5000;

export async function checkConnectivity(config: ProxyConfig): Promise<void> {
  const probes: Record<string, Promise<string>> = {};

  // Upstream LLM
  probes["upstream"] = probe(config.upstream.url);

  // ClickHouse
  if (config.clickhouse.enabled && config.clickhouse.url) {
    const ch = config.clickhouse;
    const headers: Record<string, string> = {};
    if (ch.user) headers["X-ClickHouse-User"] = ch.user;
    if (ch.password) headers["X-ClickHouse-Key"] = ch.password;
    probes["clickhouse"] = probe(`${ch.url.replace(/\/+$/, "")}/?query=${encodeURIComponent("SELECT 1")}`, headers);
  }

  // Redis
  if (config.redis.enabled) {
    probes["redis"] = probeRedis(config.redis);
  }

  // Opik
  if (config.opik.enabled && config.opik.url) {
    probes["opik"] = probe(`${config.opik.url.replace(/\/+$/, "")}/is-alive/ping`);
  }

  // Langfuse
  if (config.langfuse.enabled && config.langfuse.host) {
    probes["langfuse"] = probe(`${config.langfuse.host.replace(/\/+$/, "")}/api/public/health`);
  }

  // Auth
  if (config.auth.enabled && config.auth.url) {
    probes["auth"] = probe(config.auth.url);
  }

  // Credit report
  if (config.creditReport.url) {
    probes["creditReport"] = probe(config.creditReport.url);
  }

  // Await all
  const summary: Record<string, string> = {};
  let allOk = true;
  for (const [name, p] of Object.entries(probes)) {
    const result = await p;
    summary[name] = result;
    if (!result.startsWith("ok")) allOk = false;
  }

  if (allOk) {
    log.info("connectivity.check", { result: "all_ok", ...summary });
  } else {
    log.warn("connectivity.check", { result: "some_failed", ...summary });
  }
}

/** Probe an HTTP endpoint. Returns "ok (Xms)" or "FAIL: reason". */
async function probe(url: string, headers?: Record<string, string>): Promise<string> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const resp = await fetch(url, { method: "GET", signal: ctrl.signal, headers, redirect: "follow" });
    await resp.text().catch(() => {});
    return `ok (${Date.now() - start}ms)`;
  } catch (err: unknown) {
    return `FAIL: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe Redis with PING. */
async function probeRedis(cfg: ProxyConfig["redis"]): Promise<string> {
  const start = Date.now();
  try {
    const { default: Redis } = await import("ioredis");
    const client = cfg.url
      ? new Redis(cfg.url, { lazyConnect: true, connectTimeout: TIMEOUT, maxRetriesPerRequest: 0 })
      : new Redis({ host: cfg.host || "127.0.0.1", port: cfg.port || 6379, password: cfg.password || undefined, db: cfg.db ?? 0, lazyConnect: true, connectTimeout: TIMEOUT, maxRetriesPerRequest: 0 });
    await client.connect();
    await client.ping();
    await client.quit();
    return `ok (${Date.now() - start}ms)`;
  } catch (err: unknown) {
    return `FAIL: ${err instanceof Error ? err.message : String(err)}`;
  }
}
