/**
 * Cursor 适配器对 CLI 暴露的安装、MCP、Hook 与 worker 入口。
 * 保持 Cursor 运行边界独立，不导入 MemoryCore 或 OpenClaw 源码。
 */

export { resolveCursorConfig } from "./config.js";
export type { CursorConfig } from "./config.js";
export { createMemoryClient } from "./client.js";
export { buildSessionContext } from "./context.js";
export {
  CURSOR_ADAPTER_MARKER,
  installCursorAdapter,
  uninstallCursorAdapter,
} from "./installer.js";
export { createCursorMcpServer } from "./mcp.js";
export { handleHook } from "./hooks.js";
export { runWorker } from "./worker.js";
