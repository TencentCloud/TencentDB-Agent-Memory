#!/usr/bin/env node

// 薄启动器：加载预编译好的 memory export 脚本。
// 构建：npm run build:export-memory
// 使用：npm run export-memory -- --data-dir <dir> --out <file.zip> [--instance-id <id>] [--skip-records]

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const entryScript = path.resolve(thisDir, "../scripts/export-memory/dist/export-memory.js");

if (!fs.existsSync(entryScript)) {
  console.error("❌  预编译产物不存在: " + entryScript);
  console.error("   请先执行: npm run build:export-memory");
  process.exit(1);
}

import(entryScript);
