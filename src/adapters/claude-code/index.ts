/**
 * Claude Code adapter — barrel exports.
 *
 * Pattern B-MCP：MCP stdio server + hooks 作为 Gateway 的 HTTP 客户端。
 *
 * 模块组成：
 *   config.ts              — 环境变量解析、sessionKey 回退策略
 *   gateway-supervisor.ts  — v1 健康探测 + 熔断（Gateway 不可达时不阻塞启动）
 *   claude-code-binding.ts — Track 2 事件绑定（实现 HostEventBinding 的 4方法）
 *   mcp-server.ts          — MCP stdio server 入口（注册 3 个工具 + 启动探测）
 *   hooks/                 — Claude Code 事件钩子（UserPromptSubmit/Stop/SessionEnd）
 *     hooks/hook-runtime.ts — stdin 读取、client/binding 构造、输出工具（共享）
 *     hooks/recall.ts       — UserPromptSubmit → recall → additionalContext
 *     hooks/capture.ts      — Stop → 解析 transcript → capture
 *     hooks/session-end.ts  — SessionEnd → endSession
 */

// Config
export { loadClaudeCodeConfig, resolveSessionKey } from "./config.js";
export type { ClaudeCodeAdapterConfig } from "./config.js";

// Gateway supervisor（v1 健康探测 + 熔断）
export { GatewaySupervisor } from "./gateway-supervisor.js";
export type { GatewaySupervisorOptions } from "./gateway-supervisor.js";

// Event binding（Track 2：实现 HostEventBinding）
export { ClaudeCodeEventBinding } from "./claude-code-binding.js";

// MCP server 入口（stdio；runMcpServer 为生产入口，createMcpServer/dispatchToolCall 便于测试）
export { dispatchToolCall, createMcpServer, runMcpServer } from "./mcp-server.js";

// Hooks（阶段 2：Claude Code 事件钩子，可独立 `npx tsx` 调用）
export { main as runRecallHook } from "./hooks/recall.js";
export { main as runCaptureHook, extractLastTurn } from "./hooks/capture.js";
export { main as runSessionEndHook } from "./hooks/session-end.js";
export type { ClaudeCodeHookInput } from "./hooks/hook-runtime.js";
