#!/usr/bin/env node

// 薄启动器：加载预编译好的 Claude Code MCP server（Pattern B-MCP）。
// 构建：npm run build:plugin (tsdown 把 src/adapters/claude-code/mcp-server.ts 打到 dist/)
// 使用：memory-tdai-mcp  或  node ./bin/memory-tdai-mcp.mjs
//
// 注意：不能用 import(entryScript) 裸加载——mcp-server.ts 里的 isMainModule 检测
// (process.argv[1] === import.meta.url) 在 bin launcher 场景下不成立
// (argv[1] 是本 launcher，import.meta.url 是 dist 产物)，因此必须显式调 runMcpServer()。

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const entryScript = path.resolve(
  thisDir,
  "../dist/src/adapters/claude-code/mcp-server.mjs",
);

if (!fs.existsSync(entryScript)) {
  console.error("❌  预编译产物不存在: " + entryScript);
  console.error("   请先执行: npm run build:plugin");
  process.exit(1);
}

// Windows 下 import() 不接受 "D:\..." 裸路径（会被当成 URL 协议 d:），须转 file:// URL
import(pathToFileURL(entryScript).href)
  .then(({ runMcpServer }) => runMcpServer())
  .catch((err) => {
    console.error("[memory-tdai-mcp] fatal:", err);
    process.exit(1);
  });
