#!/usr/bin/env node

import { resolve } from "node:path";

import { ModelMemoryProxy } from "./server.js";

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const upstreamBaseUrl = process.env.TDAI_MODEL_UPSTREAM_URL;
if (!upstreamBaseUrl) {
  throw new Error("TDAI_MODEL_UPSTREAM_URL is required");
}

const proxy = new ModelMemoryProxy({
  upstreamBaseUrl,
  gatewayBaseUrl: process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420",
  gatewayApiKey: process.env.TDAI_GATEWAY_API_KEY,
  gatewayRecallTimeoutMs: integerEnv("TDAI_PROXY_RECALL_TIMEOUT_MS", 300),
  gatewayWriteTimeoutMs: integerEnv("TDAI_PROXY_WRITE_TIMEOUT_MS", 10_000),
  sessionSecret: process.env.TDAI_PROXY_SESSION_SECRET,
  sessionIdleMs: integerEnv("TDAI_PROXY_SESSION_IDLE_MS", 30 * 60_000),
  maxMemoryChars: integerEnv("TDAI_PROXY_MAX_MEMORY_CHARS", 12_000),
  outboxPath: resolve(
    process.env.TDAI_PROXY_STATE_DIR ?? ".tdai-model-proxy",
    "outbox.sqlite",
  ),
});

const address = await proxy.listen({
  host: process.env.TDAI_PROXY_HOST ?? "127.0.0.1",
  port: integerEnv("TDAI_PROXY_PORT", 8421),
});
console.info(
  `[model-proxy] Listening on http://${address.address}:${address.port}; ` +
  `upstream=${upstreamBaseUrl}`,
);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await proxy.close();
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
