/**
 * Shared adapter layer — barrel exports.
 *
 * Provides:
 *   - TdaiPlatformAdapter interface + TDAI_TOOLS definitions
 *   - To be used by Claude Code, CodeBuddy, and future platform adapters
 */

export type {
  PlatformAdapterOptions,
  PlatformTool,
  PlatformToolParam,
  PlatformLifecycle,
} from "./types.js";

export { TDAI_TOOLS } from "./types.js";
