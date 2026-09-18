#!/usr/bin/env node

// 薄启动器：加载预编译好的 VDB 导出脚本。
// 构建：npm run build:export-vdb
// 使用：npm run export:vdb -- [参数]  或  node ./bin/export-tencent-vdb.mjs [参数]

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const entryScript = path.resolve(thisDir, "../scripts/export-tencent-vdb/dist/export-tencent-vdb.js");

if (!fs.existsSync(entryScript)) {
  console.error("❌  预编译产物不存在: " + entryScript);
  console.error("   请先执行: npm run build:export-tencent-vdb");
  process.exit(1);
}

import(entryScript);
