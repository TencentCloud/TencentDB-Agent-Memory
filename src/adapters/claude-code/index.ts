/**
 * Claude Code adapter — barrel exports.
 *
 * 为 Claude Code 提供 TDAI 记忆能力:
 *   - CCHostAdapter: 实现 HostAdapter 接口的薄壳
 *   - 配合 CC MCP server 使用（暴露 tdai_* 工具）
 *   - 配合 CC hooks 使用（自动 recall + capture）
 */
export { CCHostAdapter } from "./host-adapter.js";
export type { CCHostAdapterOptions } from "./host-adapter.js";
