#!/usr/bin/env node
// 历史迁移评估（评审意见 8）：检查 SQLite 会话表里有多少记录缺 space_id，
// 并给出「spaceId 纳入归属锁」前的回填评估。
//
// 用法：node tools-2026/migrate-space-id.mjs [dbPath]
//   默认 dbPath = ~/.tdai-memory-proxy/proxy.db（容器内 /data/tdai-memory-proxy/proxy.db）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dbPath = process.argv[2] || path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db");

if (!fs.existsSync(dbPath)) {
  console.log(`数据库不存在：${dbPath}`);
  process.exit(0);
}

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  console.log("better-sqlite3 不可用，无法读取（仅评估脚本，需在 proxy 环境运行）");
  process.exit(0);
}
const db = new Database(dbPath, { readonly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
console.log("表：", tables.join(", "));

const sessionTables = tables.filter((t) => /session/i.test(t));
let total = 0;
let withSpace = 0;
let byAgent = {};
for (const t of sessionTables) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!cols.includes("key") && !cols.includes("session_id")) continue;
    const keyCol = cols.includes("key") ? "key" : "session_id";
    const rows = db.prepare(`SELECT ${keyCol} AS k, value FROM ${t}`).all();
    for (const r of rows) {
      total++;
      const v = r.value;
      const hasSpace =
        (typeof v === "string" && v.includes("space_id")) ||
        (v && typeof v === "object" && (v.space_id || v.spaceId));
      if (hasSpace) withSpace++;
      const m = String(r.k).match(/:(auto-)?([^:]+)$/);
      const agent = m ? m[2] : "?";
      byAgent[agent] = (byAgent[agent] ?? 0) + 1;
    }
  } catch {
    /* 跳过无法解析的表 */
  }
}

console.log(`\n会话记录总数：${total}`);
console.log(`已含 space_id 字段：${withSpace}（${total ? Math.round((withSpace / total) * 100) : 0}%）`);
console.log(`缺 space_id 的记录：${total - withSpace}`);
console.log("\n按 key 尾部 agent/会话分布（前 10）：");
Object.entries(byAgent)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .forEach(([k, v]) => console.log(`  ${k}: ${v}`));
console.log("\n评估：若把 spaceId 纳入归属锁 (space,team,agent,task)，");
console.log("缺 space_id 的记录需按 user/team/agent 回填（或按请求路径 spaceId 惰性回填）。");
db.close();
