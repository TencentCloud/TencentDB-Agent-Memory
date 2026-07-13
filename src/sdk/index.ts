/**
 * TDAI Memory SDK — barrel export.
 *
 * Usage:
 * ```ts
 * import { MemoryPlugin, type MemoryPlatformAdapter } from "./src/sdk/index.js";
 * ```
 */

export { MemoryPlugin } from "./plugin.js";
export type {
  MemoryPlatformAdapter,
  SdkLifecycleEvent,
  LogLevel,
} from "./adapter.js";
export type {
  PlatformKind,
  ToolRegistration,
  ResolvedLLMConfig,
  PromptContext,
  TurnContext,
  PluginRuntimeIdentity,
} from "./types.js";
