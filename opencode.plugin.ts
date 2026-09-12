/**
 * OpenCode plugin entry point for memory-tencentdb.
 *
 * This file is the default OpenCode plugin module.  OpenCode discovers it via
 * the `plugin` array in opencode.json (or equivalent) and invokes the `server`
 * function when the plugin is activated.
 *
 * ## Usage
 *
 * ### A. Declarative (open a project, edit opencode.json)
 *
 * ```json
 * {
 *   "plugin": ["@tencentdb-agent-memory/memory-tencentdb/opencode"]
 * }
 * ```
 *
 * The memory plugin will auto-configure via environment variables:
 * - `MEMORY_TENCENTDB_GATEWAY_URL` (default `http://127.0.0.1:8420`)
 * - `MEMORY_TENCENTDB_GATEWAY_API_KEY`
 * - `MEMORY_TENCENTDB_USER_ID`
 *
 * ### B. Programmatic (custom plugin entry)
 *
 * ```ts
 * import { createOpenCodeMemoryPlugin } from
 *   "@tencentdb-agent-memory/memory-tencentdb/opencode";
 *
 * export default createOpenCodeMemoryPlugin({
 *   gatewayUrl: "http://tdai-gateway.local:8420",
 *   apiKey: process.env.TDAI_API_KEY,
 * });
 * ```
 *
 * ### C. Direct import (from source)
 *
 * ```ts
 * import { createOpenCodeMemoryPlugin } from
 *   "memory-tencentdb/src/adapters/opencode/index";
 * ```
 *
 * ## Prerequisites
 *
 * 1. A TDAI Gateway process must be running and reachable.
 *    Start it with: `npx memory-tencentdb-gateway` (or equivalent).
 * 2. Ensure the Gateway has an LLM provider configured for extraction.
 */

import type { PluginModule } from "@opencode-ai/plugin";
import { createOpenCodeMemoryPlugin } from "./src/adapters/opencode/index.js";

export { createOpenCodeMemoryPlugin };
export type { OpenCodeMemoryPluginOptions } from "./src/adapters/opencode/index.js";

// Default plugin module — OpenCode calls `server()` on activation.
const plugin: PluginModule = {
  id: "memory-tencentdb",
  server: createOpenCodeMemoryPlugin(),
};

export default plugin;
