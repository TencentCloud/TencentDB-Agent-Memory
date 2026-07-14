/**
 * Codex adapter — barrel export.
 *
 * Usage in a VS Code extension activation:
 * ```ts
 * import { CodexAdapter } from "memory-tdai/src/adapters/codex/index.js";
 *
 * const adapter = new CodexAdapter({
 *   gatewayUrl: "http://127.0.0.1:8420",
 * });
 *
 * // Register tools and hooks using the adapter...
 * const recall = await adapter.recall("user message", "session-123");
 * ```
 *
 * @see CodexAdapter — Gateway-based adapter for VS Code / Codex
 */

export { CodexAdapter } from "./adapter.js";
export type { CodexAdapterOptions } from "./adapter.js";
