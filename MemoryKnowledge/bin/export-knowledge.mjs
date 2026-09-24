#!/usr/bin/env node

// 薄启动器：加载预编译好的 knowledge export 脚本。
// 构建：npm run build:export-knowledge
// 使用：npm run export-knowledge -- --data-dir <dir> --out <bundle.zip> [--asset llm-wiki|code-graph|all]

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const entryScript = path.resolve(thisDir, "../scripts/export-knowledge/dist/export-knowledge.js");

if (!fs.existsSync(entryScript)) {
  console.error("❌  预编译产物不存在: " + entryScript);
  console.error("   请先执行: npm run build:export-knowledge");
  process.exit(1);
}

import(entryScript);
