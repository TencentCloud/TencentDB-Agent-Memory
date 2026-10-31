/**
 * 回填脚本：为已有 L0/L1 记录补算 embedding 向量。
 *
 * 背景：
 *   记忆栈的 embedding provider 从 "none" 切到远端（如硅基流动）后，
 *   VectorStore.init() 会检测到 provider/model/dimensions 变化并重建向量表，
 *   但仓库当前没有任何调用 reindexAll() 的路径 —— needsReindex 标志被计算后
 *   无人消费。结果是：历史记录永远没有向量，只能被 FTS 全文检索命中，
 *   语义召回对存量数据完全失效。
 *
 * 用法（在本容器内执行，tsx 可直接跑 TS）：
 *   docker cp backfill-embeddings.ts tdai-memory-core:/tmp/
 *   docker exec tdai-memory-core node --import tsx /tmp/backfill-embeddings.ts --dry-run
 *   docker exec tdai-memory-core node --import tsx /tmp/backfill-embeddings.ts
 *
 * 参数：
 *   --dry-run           只统计待回填数量，不调用 embedding API
 *   --data-dir <path>   数据目录，默认 /data/tdai-memory
 *   --config <path>    gateway yaml，默认 /data/config/tdai-gateway.yaml
 */
import { readFileSync } from "node:fs";
import { createStoreBundle } from "/app/src/core/store/factory.ts";
import { createEmbeddingService } from "/app/src/core/store/embedding.ts";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const arg = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const DRY = has("--dry-run");
const DATA_DIR = arg("--data-dir", "/data/tdai-memory");
const CONFIG = arg("--config", "/data/config/tdai-gateway.yaml");

/* ── 解析 gateway yaml 的 embedding 段（只取需要的标量，避免引入 yaml 依赖）── */
function readEmbeddingConfig(path: string) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  let inEmbed = false;
  let inEmbedBlock = false;
  const cfg: Record<string, string> = {};
  for (const line of lines) {
    if (/^\s{2}embedding:\s*$/.test(line)) { inEmbed = true; continue; }
    if (inEmbed) {
      // 离开 embedding 块（下一个同级或更浅的 key）
      if (/^\s{0,2}\S/.test(line) && !/^\s{2}embedding:/.test(line)) break;
      const m = line.match(/^\s{4}([A-Za-z]+):\s*(.*)$/);
      if (m) {
        inEmbedBlock = true;
        cfg[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
  void inEmbedBlock;
  return {
    provider: cfg.provider || "none",
    baseUrl: cfg.baseUrl || "",
    apiKey: cfg.apiKey || "",
    model: cfg.model || "",
    dimensions: Number(cfg.dimensions || 0),
    sendDimensions: cfg.sendDimensions === "true",
    maxInputChars: Number(cfg.maxInputChars || 5000),
  };
}

async function main() {
  const ec = readEmbeddingConfig(CONFIG);
  console.log(`[backfill] embedding 配置: provider=${ec.provider} model=${ec.model} dims=${ec.dimensions} baseUrl=${ec.baseUrl}`);

  if (ec.provider === "none" || !ec.apiKey) {
    console.error(
      "[backfill] 终止：embedding 未启用或缺少 apiKey。" +
      " 请先在 .env 设置 MEMORY_CORE_EMBEDDING_API_KEY 并重启 memory-core。",
    );
    process.exit(2);
  }

  const bundle = createStoreBundle(
    {
      storeBackend: "sqlite",
      bm25: { enabled: true, language: "zh" },
      tcvdb: { url: "", apiKey: "", database: "", embeddingEnabled: false },
      embedding: {
        enabled: true,
        provider: ec.provider,
        baseUrl: ec.baseUrl,
        apiKey: ec.apiKey,
        model: ec.model,
        dimensions: ec.dimensions,
        sendDimensions: ec.sendDimensions,
        maxInputChars: ec.maxInputChars,
      },
    } as never,
    {
    dataDir: DATA_DIR,
    logger: {
      debug: (m: string) => console.debug(`[store] ${m}`),
      info: (m: string) => console.log(`[store] ${m}`),
      warn: (m: string) => console.warn(`[store][warn] ${m}`),
      error: (m: string) => console.error(`[store][error] ${m}`),
    },
  } as never,
  );

  const store = bundle.store;
  const svc = bundle.embedding!;

  const init = await store.init(svc.getProviderInfo());
  console.log(`[backfill] store.init → needsReindex=${init.needsReindex} reason=${init.reason ?? "-"}`);
  if (store.isDegraded()) {
    console.error("[backfill] 终止：VectorStore 处于 degraded 模式。");
    process.exit(3);
  }

  // 统计待回填数量
  const anyStore = store as unknown as {
    getAllL1Texts?: () => unknown[];
    getAllL0Texts?: () => unknown[];
  };
  const l1Total = anyStore.getAllL1Texts?.().length ?? 0;
  const l0Total = anyStore.getAllL0Texts?.().length ?? 0;
  console.log(`[backfill] 待回填: L1=${l1Total} L0=${l0Total}`);

  if (DRY) {
    console.log("[backfill] --dry-run 结束，未调用 embedding API。");
    process.exit(0);
  }

  const t0 = Date.now();
  const res = await store.reindexAll(
    (text: string) => svc.embed(text),
    (done: number, total: number, layer: string) => {
      if (done % 50 === 0 || done === total) {
        console.log(`[backfill] ${layer} ${done}/${total} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      }
    },
  );
  console.log(
    `[backfill] 完成: L1=${res.l1Count} L0=${res.l0Count} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );

}
main().catch((e) => {
  console.error("[backfill] 失败:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
