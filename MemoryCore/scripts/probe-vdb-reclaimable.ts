/**
 * 一次性排查脚本（**只读**）：识别 VDB 上可安全清理的一次性测试残留库。
 *
 * 背景：实例集合数已达上限 1500/1500，无法新建库。需要先回收测试残留。
 *
 * 判定规则（只认**明确带一次性测试特征**的库，宁漏不误伤）：
 *   - `memory-tdai-test-*`        自动化 e2e 生成，名字里带随机 run id
 *   - `verify_memory_bm25_*`      BM25 验证脚本生成，名字里带时间戳
 *   - `clearverify-*`             本次 clear 验证脚本生成
 *   - `*_probe` / `*probe*`       探测用临时库
 *
 * 明确**排除**（可能是别人在用的长期环境）：
 *   - memory-tencentdb-testing-*  共享测试库
 *   - memory_dev_*               开发环境库
 *   - 其它不匹配上述模式的一切库
 *
 * 本脚本只输出清单与统计，**不执行任何删除**。
 */
import { TcvdbClient } from "../src/core/store/tcvdb-client.js";

const VDB_URL = process.env.VDB_URL;
const VDB_API_KEY = process.env.VDB_API_KEY;

if (!VDB_URL || !VDB_API_KEY) {
  console.error("需要环境变量 VDB_URL / VDB_API_KEY");
  process.exit(2);
}

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 明确的一次性测试库特征。 */
const DISPOSABLE_PATTERNS: Array<{ name: string; test: (db: string) => boolean }> = [
  { name: "memory-tdai-test-*", test: (d) => d.startsWith("memory-tdai-test-") },
  { name: "verify_memory_bm25_*", test: (d) => d.startsWith("verify_memory_bm25_") },
  { name: "clearverify-*", test: (d) => d.startsWith("clearverify-") },
];

/** 明确保护、绝不纳入清理清单。 */
const PROTECTED_PATTERNS: Array<(db: string) => boolean> = [
  (d) => d.startsWith("memory-tencentdb-testing"),
  (d) => d.startsWith("memory_dev_"),
];

function classify(db: string): { disposable: boolean; reason: string } {
  for (const p of PROTECTED_PATTERNS) {
    if (p(db)) return { disposable: false, reason: "protected" };
  }
  for (const p of DISPOSABLE_PATTERNS) {
    if (p.test(db)) return { disposable: true, reason: p.name };
  }
  return { disposable: false, reason: "unknown-keep" };
}

async function main() {
  const client = new TcvdbClient({
    url: VDB_URL!,
    username: process.env.VDB_USERNAME ?? "root",
    apiKey: VDB_API_KEY!,
    database: process.env.VDB_DATABASE ?? "default",
    timeout: 30_000,
    logger: silent,
  });

  const dbResp = await client.request<{ databases?: string[] }>("/database/list", {});
  const dbs = dbResp.databases ?? [];

  let totalCols = 0;
  let reclaimable = 0;
  const byReason = new Map<string, { dbs: number; cols: number }>();
  const keepUnknown: string[] = [];

  for (const db of dbs) {
    let n = 0;
    try {
      const r = await client.request<{ collections?: Array<{ collection?: string }> }>(
        "/collection/list", { database: db },
      );
      n = (r.collections ?? []).length;
    } catch { /* 统计不到就按 0 计 */ }
    totalCols += n;

    const { disposable, reason } = classify(db);
    const slot = byReason.get(reason) ?? { dbs: 0, cols: 0 };
    slot.dbs++;
    slot.cols += n;
    byReason.set(reason, slot);

    if (disposable) reclaimable += n;
    else if (reason === "unknown-keep") keepUnknown.push(db);
  }

  console.log(`库总数: ${dbs.length}`);
  console.log(`集合总数: ${totalCols} / 1500（余量 ${1500 - totalCols}）\n`);

  console.log("按分类统计:");
  for (const [reason, s] of [...byReason.entries()].sort((a, b) => b[1].cols - a[1].cols)) {
    const tag = DISPOSABLE_PATTERNS.some((p) => p.name === reason) ? "可清理" : "保留";
    console.log(`  [${tag}] ${reason.padEnd(24)} ${String(s.dbs).padStart(4)} 库${String(s.cols).padStart(5)} 集合`);
  }

  console.log(`\n可回收集合数: ${reclaimable}（清理后余量约 ${1500 - totalCols + reclaimable}）`);
  console.log(`未识别、保守保留的库: ${keepUnknown.length} 个`);
  if (keepUnknown.length) console.log(`  示例: ${keepUnknown.slice(0, 10).join(", ")}`);
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
