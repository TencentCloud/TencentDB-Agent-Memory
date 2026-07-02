/**
 * Claude Code 适配器模块入口。
 */
export { ClaudeCodeMemoryAdapter } from "./claude-code-adapter.js";
export {
  generateBeforeRecallHook,
  generateAfterCaptureHook,
  generateStopHook,
  generateClaudeCodeHookConfig,
} from "./claude-code-hooks.js";
export type {
  ClaudeCodeHookConfig,
  ClaudeCodeHookEntry,
} from "./claude-code-hooks.js";
export { generateClaudeCodeMcpConfig } from "./claude-code-config.js";
export type {
  ClaudeCodeMcpConfig,
  ClaudeCodeMcpServer,
} from "./claude-code-config.js";
