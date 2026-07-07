#!/usr/bin/env node
/**
 * split-evidence.mjs —— 按 sessionKey 切分 real-env 对话日志到 evidence/phase-X/ 子目录。
 *
 * 为什么需要这个脚本：
 *   PowerShell 默认编码不是 UTF-8，直接 Get-Content/Out-File 处理含中文的
 *   JSONL 会损坏字符（之前测试日志里已经出现 ??? 乱码）。Node 的 fs 默认 UTF-8
 *   安全，且能用 JSON.parse 严格按 sessionKey 过滤，避免误归类。
 *
 * 输入：
 *   .test-data/real-env/conversations/2026-07-04.jsonl  (含 smoke-test + 0cee18cb + Codex)
 *   .test-data/real-env/conversations/2026-07-06.jsonl  (含 dify-test + xb-test-a)
 *
 * 输出：
 *   evidence/phase1-cc/conversations-smoke-test.jsonl     (Phase 0 precheck)
 *   evidence/phase1-cc/conversations-claude-code.jsonl    (Phase 1 CC)
 *   evidence/phase2-cx/conversations-codex.jsonl          (Phase 2 CX)
 *   evidence/phase3-df/conversations-dify.jsonl           (Phase 3 DF)
 *   evidence/phase4-xb/conversations-xb.jsonl             (Phase 4 XB)
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = "d:/GK/Project/NEKO/TencentDB-Agent-Memory";
const SRC_DIR = path.join(ROOT, ".test-data/real-env/conversations");
const OUT = {
  smoke: path.join(ROOT, "evidence/phase1-cc/conversations-smoke-test.jsonl"),
  cc: path.join(ROOT, "evidence/phase1-cc/conversations-claude-code.jsonl"),
  cx: path.join(ROOT, "evidence/phase2-cx/conversations-codex.jsonl"),
  df: path.join(ROOT, "evidence/phase3-df/conversations-dify.jsonl"),
  xb: path.join(ROOT, "evidence/phase4-xb/conversations-xb.jsonl"),
};

// sessionKey → 目标文件 映射
const KEY_MAP = {
  "smoke-test": "smoke",
  "0cee18cb-0368-4db2-9807-867057075251": "cc",
  "D:/GK/Project/NEKO/TencentDB-Agent-Memory::2026-07-04": "cx",
  "dify-test": "df",
  "xb-test-a": "xb",
};

const buckets = { smoke: [], cc: [], cx: [], df: [], xb: [], unknown: [] };

function splitFile(filename) {
  const filepath = path.join(SRC_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.warn(`[skip] not found: ${filepath}`);
    return;
  }
  const raw = fs.readFileSync(filepath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  let parsed = 0;
  let unknown = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const key = obj.sessionKey;
      const bucket = KEY_MAP[key];
      if (bucket) {
        buckets[bucket].push(line);
      } else {
        buckets.unknown.push(line);
        unknown++;
        console.warn(`[unknown sessionKey] file=${filename} key=${key}`);
      }
      parsed++;
    } catch (e) {
      console.warn(`[parse fail] file=${filename} err=${e.message}`);
    }
  }
  console.log(`[${filename}] parsed=${parsed} unknown=${unknown}`);
}

splitFile("2026-07-04.jsonl");
splitFile("2026-07-06.jsonl");

// 写出每个桶
for (const [name, filepath] of Object.entries(OUT)) {
  const lines = buckets[name];
  if (lines.length === 0) {
    console.warn(`[empty bucket] ${name} → ${filepath}`);
  }
  fs.writeFileSync(filepath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  console.log(`[wrote] ${filepath} (${lines.length} lines)`);
}

if (buckets.unknown.length > 0) {
  console.warn(`[WARN] ${buckets.unknown.length} lines had unknown sessionKey, not written to any phase`);
  process.exit(1);
}
console.log("[done] all buckets written");
