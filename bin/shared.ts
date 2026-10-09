/**
 * Shared environment loader for all MCP server entry points.
 *
 * See bin/env-common.ts for the transport-neutral variables (LLM config,
 * data dir, memory overrides, user id). This module adds only:
 *
 *   TDAI_SESSION_KEY   — default session key
 *                        (falls back to the platform's own session env var,
 *                         then to a process-stable UUID)
 */

import { loadCommonEnv } from "./env-common.js";
import type { McpServerBaseOptions } from "../src/adapters/mcp-server-base.js";

export function loadEnvOptions(defaultDirName: string): McpServerBaseOptions {
  return {
    ...loadCommonEnv(defaultDirName),
    defaultSessionKey: process.env["TDAI_SESSION_KEY"],
  };
}
