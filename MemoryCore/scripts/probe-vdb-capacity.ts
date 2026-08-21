/**
 * 一次性排查脚本（**只读**）：统计 VDB 库数量与集合占用，定位集合数超限来源。
 *
 * 背景：VDB 实例集合数上限 1500。每个 memory 库会占 8 个集合，新建库前需要
 * 确认还有余量，否则 createCollection 会以 code=15129 失败、store 进 degraded
 * 模式，导致后续所有写入静默失败（已实测踩到）。
 *
 * 本脚本不做任何创建/删除，只输出统计，供人工判断清理哪些库。
 */
import { TcvdbClient } from "../src/core/store/tcvdb-client.js";

const VDB_URL = process.env.VDB_URL;
const VDB_API_KEY = process.env.VDB_API_KEY;

if (!VDB_URL || !VDB_API_KEY) {
  console.error("需要环境变量 VDB_URL / VDB_API_KEY");
  process.exit(2);
}

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function main() {
  const client = new TcvdbClient({
    url: VDB_URL!,
    username: process.env.VDB_USERNAME ?? "root",
    apiKey: VDB_API_KEY!,
    database: process.env.VDB_DATABASE ?? "default",
    timeout: 30_000,
    logger: silent,
  });

  // TcvdbClient 没有封装 list 接口，直接用底层 request 调（只读）
  const dbResp = await client.request<{ databases?: string[] }>("/database/list", {});
  const dbs = dbResp.databases ?? [];
  console.log(`库总数: ${dbs.length}`);

  const counts: Array<{ db: string; n: number }> = [];
  let total = 0;
  for (const db of dbs) {
    try {
      const r = await client.request<{ collections?: Array<{ collection?: string }> }>(
        "/collection/list", { database: db },
      );
      const n = (r.collections ?? []).length;
      counts.push({ db, n });
      total += n;
    } catch {
      counts.push({ db, n: -1 }); // 无权限或异常
    }
  }

  console.log(`集合总数: ${total} / 1500（余量 ${1500 - total}）`);

  const leftovers = counts.filter((c) => c.db.startsWith("clearverify-"));
  console.log(`\n本验证脚本残留库 clearverify-*: ${leftovers.length} 个`);
  for (const c of leftovers) console.log(`  ${c.db}  (${c.n} 集合)`);

  counts.sort((a, b) => b.n - a.n);
  console.log("\n集合数 top 15:");
  for (const c of counts.slice(0, 15)) {
    console.log(`  ${String(c.n).padStart(5)}  ${c.db}`);
  }
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
