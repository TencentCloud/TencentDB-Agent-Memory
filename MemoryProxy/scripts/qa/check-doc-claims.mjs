#!/usr/bin/env node
/**
 * 校验文档里声明的用例数是否与真实结果一致。
 *
 * 为什么需要：docs 里多处手写了「某个测试文件多少个用例」（字段矩阵、可观测说明、
 * 会话策略等）。改代码后没人记得同步，文档就会跟代码对不上——历史上已经发生过几次
 * （probe 12→17、接缝用例 7→8、role-rules 整节漏记）。这里把这类数字变成可校验的：
 *
 *   1. 读 `npm test` 留下的 .vitest-report.json，拿到每个测试文件的真实用例数
 *      （没有报告时自己跑一次 vitest，方便单独执行本脚本）；
 *   2. 扫 docs/**.md，凡「测试文件名 + 紧跟一个数字」的写法都当作一条声明；
 *   3. 文件不在当前分支（例如另一支 PR 才带的用例）→ 跳过；
 *      数字与实测不符 → 报错并逐条列出差异。
 *
 * 只校验单文件数字；聚合口径（"12 个文件 / 150 用例"）不在这里校验。
 *
 * 用法：
 *   npm test                                      # 测试跑完自动校验（posttest）
 *   node scripts/qa/check-doc-claims.mjs          # 单独校验，不一致则退出码 1
 *   node scripts/qa/check-doc-claims.mjs --list   # 打印实测用例数，便于回填文档
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = path.join(ROOT, "docs");
const REPORT = path.join(ROOT, ".vitest-report.json");
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");

/** 声明写法：文件名后面紧跟（≤4 个非数字字符内）的整数。 */
const CLAIM_RE = /([A-Za-z0-9_./-]+\.test\.ts)[^\d\n]{0,4}(\d+)/g;

function collectDocFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectDocFiles(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

function actualCounts() {
  let report = null;
  if (existsSync(REPORT)) {
    try {
      report = JSON.parse(readFileSync(REPORT, "utf8"));
    } catch {
      report = null;
    }
    // 读完即删：该报告由同一次 `npm test` 生成，删除可避免下一次单独执行时
    // 读到上一次运行或另一个分支留下的过期结果（曾导致校验假通过）。
    rmSync(REPORT, { force: true });
  }
  if (!report) {
    // 单独跑本脚本时自己产报告；分支上还没有测试文件时 vitest 不写报告
    // （--passWithNoTests），按空结果处理。
    try {
      execFileSync(
        process.execPath,
        [VITEST, "run", "--passWithNoTests", "--reporter=json", `--outputFile=${REPORT}`],
        { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] },
      );
      report = JSON.parse(readFileSync(REPORT, "utf8"));
    } catch {
      report = { testResults: [], numTotalTests: 0 };
    }
    rmSync(REPORT, { force: true });
  }
  const byName = new Map();
  for (const suite of report.testResults ?? []) {
    byName.set(path.basename(suite.name), (suite.assertionResults ?? []).length);
    byName.set(path.relative(ROOT, suite.name).split(path.sep).join("/"), (suite.assertionResults ?? []).length);
  }
  return { byName, total: report.numTotalTests ?? 0, files: (report.testResults ?? []).length };
}

const list = process.argv.includes("--list");

if (list) {
  const { byName, total, files } = actualCounts();
  for (const [name, count] of [...byName.entries()].sort()) {
    if (name.startsWith("src/")) console.log(`${String(count).padStart(4)}  ${name}`);
  }
  console.log(`\n合计 ${files} 个文件 / ${total} 个用例`);
  process.exit(0);
}

const { byName } = actualCounts();

const checked = [];
const skipped = [];
const mismatched = [];

for (const doc of existsSync(DOCS) ? collectDocFiles(DOCS) : []) {
  const rel = path.relative(ROOT, doc).split(path.sep).join("/");
  const text = readFileSync(doc, "utf8");
  for (const m of text.matchAll(CLAIM_RE)) {
    const [, file, claimed] = m;
    const actual = byName.get(file) ?? byName.get(path.basename(file));
    if (actual === undefined) {
      skipped.push({ doc: rel, file, claimed: Number(claimed) });
      continue;
    }
    if (actual !== Number(claimed)) {
      mismatched.push({ doc: rel, file, claimed: Number(claimed), actual });
    } else {
      checked.push({ doc: rel, file, count: actual });
    }
  }
}

if (mismatched.length > 0) {
  console.error("文档里的用例数与实测不符：\n");
  for (const m of mismatched) {
    console.error(`  ${m.doc}: ${m.file} 文档写 ${m.claimed}，实测 ${m.actual}`);
  }
  console.error("\n请同步文档，或用 node scripts/qa/check-doc-claims.mjs --list 取实测值。");
  process.exit(1);
}

console.log(`文档用例数校验通过：核对 ${checked.length} 条，跳过 ${skipped.length} 条（不在本分支的测试文件）。`);
