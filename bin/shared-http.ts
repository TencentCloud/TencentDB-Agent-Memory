/**
 * Shared environment loader for all HTTP server entry points.
 *
 * See bin/env-common.ts for the transport-neutral variables (LLM config,
 * data dir, memory overrides, user id). This module adds only:
 *
 *   TDAI_PORT              — HTTP listen port (default: the caller's defaultPort)
 *   TDAI_HOST              — HTTP bind address (default: "127.0.0.1")
 *   TDAI_GATEWAY_API_KEY   — Bearer auth token (TDAI_API_KEY also accepted)
 *   TDAI_CORS_ORIGINS      — comma-separated CORS allow-list
 */

import { loadCommonEnv, parseIntEnv } from "./env-common.js";
import type { HttpServerBaseOptions } from "../src/adapters/http-server-base.js";

export function loadHttpEnvOptions(
  defaultDirName: string,
  defaultPort = 8420,
): HttpServerBaseOptions {
  const corsRaw = process.env["TDAI_CORS_ORIGINS"];
  const corsOrigins = corsRaw
    ? corsRaw.split(",").map((o) => o.trim()).filter(Boolean)
    : undefined;

  return {
    ...loadCommonEnv(defaultDirName),
    port: parseIntEnv("TDAI_PORT") ?? defaultPort,
    host: process.env["TDAI_HOST"] ?? "127.0.0.1",
    apiKey: process.env["TDAI_GATEWAY_API_KEY"] ?? process.env["TDAI_API_KEY"],
    corsOrigins,
  };
}
