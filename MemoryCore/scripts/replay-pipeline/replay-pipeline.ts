#!/usr/bin/env npx tsx
/**
 * L0→L3 回放 / 重跑工具
 *
 * 对已有 memory-tdai 数据目录重新执行 L1（原子抽取）→ L2（场景块）→
 * L3（Persona 生成），并录制每一层 LLM 调用的 systemPrompt / prompt /
 * response / 耗时。用于：
 *   1. 排查"为什么抽出这条记忆"——看重跑时喂给模型的完整上下文
 *   2. 对比两次运行（不同模型 / 配置）的抽取差异
 *
 * 注意：这是"隔离重跑"，不是"历史回放"。它展示当前数据重跑的结果；
 * 历史运行输入、模型版本与检索候选未保存，不能还原历史运行当时的结果。
 *
 * 默认安全策略：把数据目录**复制**到临时工作目录再重跑，不污染线上数据。
 * 只有本工具 mkdtemp 创建的临时目录会被自动清理；用户用 --work-dir 指定
 * 的目录永远不会被自动删除。--no-copy 直接在原目录执行（危险，仅调试用）。
 *
 * @example
 *   # 列出数据目录里的 session
 *   npx tsx replay-pipeline.ts -d ~/.openclaw/memory-tdai --list-sessions
 *
 *   # 全链路重跑（干净重建），录制所有 LLM 调用
 *   npx tsx replay-pipeline.ts -d ~/.openclaw/memory-tdai \
 *     --llm-base-url https://api.openai.com/v1 \
 *     --llm-api-key $OPENAI_API_KEY \
 *     --llm-model gpt-4o \
 *     --output replay-report.json
 *
 *   # 只重跑 L1，指定 session，脱敏
 *   npx tsx replay-pipeline.ts -d ~/.openclaw/memory-tdai \
 *     --stages L1 --session-key sess_xxx \
 *     --llm-base-url ... --llm-api-key ... --llm-model gpt-4o \
 *     --redact --output replay-l1.json
 *
 *   # 对比两次运行
 *   npx tsx replay-pipeline.ts --compare replay-a.json replay-b.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { mkdtemp, cp, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";

// ─────────────────────────────────────────────
// Imports (deferred where heavy)
// ─────────────────────────────────────────────

import { parseConfig } from "../../src/config.js";
import type { MemoryTdaiConfig } from "../../src/config.js";
import { initStores, resetStores, createL1Runner, createL2Runner, createL3Runner } from "../../src/utils/pipeline-factory.js";
import type { PipelineLogger } from "../../src/utils/pipeline-factory.js";
import { StandaloneLLMRunnerFactory } from "../../src/adapters/standalone/llm-runner.js";
import { LocalStorageBackend } from "../../src/core/storage/local-backend.js";
import { StorageAdapter } from "../../src/core/storage/adapter.js";
import { StoragePaths } from "../../src/core/storage/types.js";
import { DEFAULT_PROFILE_SCOPE, buildProfileIsolationScope } from "../../src/core/profile/profile-sync.js";
import type { ProfileIsolation } from "../../src/core/profile/profile-sync.js";
import { CheckpointManager } from "../../src/utils/checkpoint.js";
import type { PipelineSessionState } from "../../src/utils/checkpoint.js";
import { RecordingLLMRunnerFactory } from "./recording-runner.js";
import type { RecordedLlmCall } from "./recording-runner.js";

const TAG = "[replay-pipeline]";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface CliOptions {
  dataDir?: string;
  workDir?: string;
  noCopy: boolean;
  keepWorkDir: boolean;
  /** 清空派生数据（L1 记录 / scene_blocks / persona / checkpoint），做隔离的 L0→L3 重建。 */
  clean: boolean;
  /** 保留已有 checkpoint 与派生数据（增量继续）。与 clean 互斥。 */
  keepState: boolean;
  /** 报告中的 prompt/response 做脱敏（邮箱/手机号/密钥）。 */
  redact: boolean;
  /** 危险模式确认：--no-copy --clean 必须显式携带。 */
  dangerous: boolean;
  listSessions: boolean;
  sessionKey?: string;
  stages: Array<"L1" | "L2" | "L3">;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  enableDedup: boolean;
  output: string;
  compare?: [string, string];
  configFile?: string;
  help: boolean;
}

/** 一个 profile scope（L2/L3 的隔离维度）。legacy scope = DEFAULT_PROFILE_SCOPE。 */
interface ProfileScope {
  /** scope 名（如 "team:T|agent:A"），legacy 根目录用 DEFAULT_PROFILE_SCOPE。 */
  name: string;
  /** 在 storage 中的 key 前缀，如 "profiles/<encoded>/"。legacy 为空。 */
  storagePrefix: string;
  /** 在本地 fs 中的目录路径。 */
  dir: string;
}

interface StageReport {
  /** 本阶段触发的 LLM 调用（原始 prompt / response / 耗时）。 */
  llmCalls: RecordedLlmCall[];
  /** 本阶段额外快照（如 L1 stored count、L2 scene 前后、L3 persona 前后）。 */
  detail: Record<string, unknown>;
  /** 阶段执行结果：ok / failed / skipped。 */
  status: "ok" | "failed" | "skipped";
}

/** L2/L3 按 profile scope 的快照（legacy scope 键为 "global"）。 */
interface ProfileSnapshot {
  scenesBefore: string[];
  scenesAfter: string[];
  personaBeforeChars: number;
  personaAfterChars: number;
  personaChanged: boolean;
}

interface ReplayReport {
  tool: string;
  version: string;
  createdAt: string;
  dataDir: string;
  workDir?: string;
  sessionKey?: string;
  stages: Array<"L1" | "L2" | "L3">;
  llm: { baseUrl: string; model: string };
  enableDedup: boolean;
  clean: boolean;
  /** 报告是否已脱敏。 */
  redacted: boolean;
  /** 全局是否失败（任一阶段失败 → true）。 */
  failed: boolean;
  results: {
    L1?: StageReport;
    L2?: StageReport;
    L3?: StageReport;
  };
  /** L2/L3 的 profile scope 快照（key 为 scope 名，legacy 为 "global"）。 */
  profiles?: Record<string, ProfileSnapshot>;
}

const HELP_TEXT = `
📼  L0→L3 回放 / 重跑工具

说明：本工具对已有 memory-tdai 数据目录重新执行 L1（原子抽取）→ L2
（场景块）→ L3（Persona 生成），并录制每一层 LLM 调用的 prompt / response
/ 耗时。它是"隔离重跑"，不是"历史回放"——它展示当前数据重跑的结果，
不能证明历史运行当时为何得到该结果（历史输入与模型输出未被保存）。

默认安全策略：把数据目录**复制**到临时工作目录再重跑，不污染线上数据。
只有由本工具 mkdtemp 创建的临时目录才会被自动清理；用户用 --work-dir
指定的目录永远不会被自动删除。--no-copy 直接在原目录执行（危险）。

⚠️  报告包含完整对话内容（prompt 与模型输出），注意保管，避免泄露。
⚠️  默认模式直接复制活跃 SQLite（WAL）数据库，不保证与线上进程写入一致；
    对正在运行的 Agent 数据目录重跑结果可能受快照不一致影响。

Usage:
  npx tsx replay-pipeline.ts -d <数据目录> [选项]
  npx tsx replay-pipeline.ts --compare <报告1.json> <报告2.json>

Options:
  -d, --data-dir <路径>     已有 memory-tdai 数据目录（含 vectors.db）
      --list-sessions        只列出数据目录中的 session key，不执行重跑
      --session-key <key>    只重跑指定 session（默认重跑所有 session）
      --stages <L1,L2,L3>    重跑哪些层级（默认 L1,L2,L3）
      --llm-base-url <url>   LLM API base URL（必需）
      --llm-api-key <key>    LLM API key（必需）
      --llm-model <model>    LLM 模型名（必需）
      --config <file>        JSON 配置文件（与 CLI 参数 deep-merge，CLI 优先）
      --enable-dedup         L1 开启冲突去重（需要 embedding 配置）
      --clean                清空派生数据做隔离重建（默认开启；与 --keep-state 互斥）
      --keep-state           保留已有 checkpoint 与派生数据（增量继续）
      --redact               报告中对 prompt/response 做脱敏（邮箱/手机号/密钥）
      --dangerous            确认危险模式：--no-copy --clean（会删除原目录派生数据）
      --work-dir <路径>      指定工作目录（默认临时目录；指定的目录不会被自动删除）
      --no-copy              不复制，直接在原数据目录上重跑（危险！会写数据）
      --keep-workdir         保留临时工作目录不清理
  -o, --output <file>        报告输出 JSON 路径（默认 ./replay-report.json）
      --compare <a> <b>      对比两份报告并打印差异摘要
  -h, --help                 显示帮助

安全规则：
  - 只有本工具创建的临时目录会被自动清理。
  - --no-copy 与 --clean 不能同时使用（除非加 --dangerous 明确确认）。
  - --session-key + --no-copy + --clean 组合被拒绝（无法局部清理其他 session）。

Examples:
  # 列出 session
  npx tsx replay-pipeline.ts -d ~/.openclaw/memory-tdai --list-sessions

  # 全链路重跑（干净重建），录制 LLM 调用
  npx tsx replay-pipeline.ts -d ~/.openclaw/memory-tdai \\
    --llm-base-url https://api.openai.com/v1 --llm-api-key $KEY --llm-model gpt-4o \\
    --output replay.json

  # 对比两次运行
  npx tsx replay-pipeline.ts --compare replay-a.json replay-b.json
`.trim();

// ─────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────

function parseCli(): CliOptions {
  const parsed = parseArgs({
    options: {
      "data-dir": { type: "string", short: "d" },
      "work-dir": { type: "string" },
      "no-copy": { type: "boolean", default: false },
      "keep-workdir": { type: "boolean", default: false },
      clean: { type: "boolean", default: true },
      "keep-state": { type: "boolean", default: false },
      redact: { type: "boolean", default: false },
      dangerous: { type: "boolean", default: false },
      "list-sessions": { type: "boolean", default: false },
      "session-key": { type: "string" },
      stages: { type: "string" },
      "llm-base-url": { type: "string" },
      "llm-api-key": { type: "string" },
      "llm-model": { type: "string" },
      "enable-dedup": { type: "boolean", default: false },
      output: { type: "string", short: "o", default: "./replay-report.json" },
      compare: { type: "string", multiple: true },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  const values = parsed.values;
  const positionals = parsed.positionals;

  if (values.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const compare = values.compare as string[] | undefined;

  // compare mode：只需要两份报告（--compare 可接 1~2 个值，第二个走 positionals）
  if (compare && compare.length >= 1) {
    const pair: [string, string] = [compare[0]!, positionals[0] ?? compare[1] ?? ""];
    if (!pair[1]) {
      console.error("❌ --compare 需要两份报告路径");
      process.exit(1);
    }
    return {
      dataDir: undefined,
      workDir: undefined,
      noCopy: false,
      keepWorkDir: false,
      clean: false,
      keepState: false,
      redact: false,
      dangerous: false,
      listSessions: false,
      enableDedup: false,
      stages: ["L1", "L2", "L3"],
      output: "./replay-report.json",
      compare: pair,
      help: false,
    };
  }

  const dataDir = values["data-dir"];
  if (!dataDir) {
    console.error("❌ 缺少必填参数: --data-dir (-d)");
    console.error("   使用 --help 查看用法");
    process.exit(1);
  }
  const resolvedDataDir = path.resolve(dataDir);
  if (!fs.existsSync(resolvedDataDir)) {
    console.error(`❌ 数据目录不存在: ${resolvedDataDir}`);
    process.exit(1);
  }

  const rawStages = (values.stages ?? "L1,L2,L3").toUpperCase().split(",").map((s) => s.trim());
  const stages = (["L1", "L2", "L3"] as const).filter((s) => rawStages.includes(s));
  if (stages.length === 0) {
    console.error(`❌ 无效的 --stages: ${values.stages}  （可选: L1, L2, L3）`);
    process.exit(1);
  }

  const clean = values.clean === true && values["keep-state"] !== true;
  const keepState = values["keep-state"] === true;
  if (clean && keepState) {
    console.error("❌ --clean 与 --keep-state 互斥，只能二选一");
    process.exit(1);
  }

  const noCopy = values["no-copy"] === true;
  const dangerous = values.dangerous === true;
  const sessionKey = values["session-key"] as string | undefined;

  // 危险组合校验：
  // - --no-copy + --clean：会删除原目录全部派生数据 → 需要 --dangerous
  // - --no-copy + --session-key + --clean：无法局部清理其他 session → 直接拒绝
  if (noCopy && clean) {
    if (sessionKey) {
      console.error(`❌ --no-copy + --session-key + --clean 组合被拒绝：无法局部清理其他 session 的派生数据`);
      console.error("   请先复制到临时目录（去掉 --no-copy），或用 --keep-state 增量继续");
      process.exit(1);
    }
    if (!dangerous) {
      console.error("❌ --no-copy + --clean 会删除原目录全部派生数据（L1/scene/persona/checkpoint）");
      console.error("   如确认要清理原目录，请显式加 --dangerous");
      process.exit(1);
    }
    logger.warn("--dangerous: 已确认将对原数据目录执行 --clean（删除全部派生数据）");
  }

  return {
    dataDir: resolvedDataDir,
    workDir: values["work-dir"] ? path.resolve(values["work-dir"]) : undefined,
    noCopy,
    keepWorkDir: values["keep-workdir"] === true,
    clean,
    keepState,
    redact: values.redact === true,
    dangerous,
    listSessions: values["list-sessions"] === true,
    sessionKey,
    stages,
    llmBaseUrl: values["llm-base-url"] as string | undefined,
    llmApiKey: values["llm-api-key"] as string | undefined,
    llmModel: values["llm-model"] as string | undefined,
    enableDedup: values["enable-dedup"] === true,
    output: path.resolve(values.output as string),
    configFile: values.config as string | undefined,
    help: false,
  };
}

// ─────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────

const logger: PipelineLogger = {
  debug: (msg: string) => { if (process.env.REPLAY_DEBUG) console.log(`  ${msg}`); },
  info: (msg: string) => console.log(`  ${msg}`),
  warn: (msg: string) => console.warn(`⚠️  ${msg}`),
  error: (msg: string) => console.error(`❌  ${msg}`),
};

// ─────────────────────────────────────────────
// Config assembly
// ─────────────────────────────────────────────

function loadConfigFile(file?: string): Record<string, unknown> {
  if (!file) return {};
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`❌ Config file not found: ${resolved}`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    console.error(`❌ Failed to parse config file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const b = base[key];
    const o = override[key];
    if (isPlainObject(b) && isPlainObject(o)) {
      result[key] = { ...b, ...o };
    } else {
      result[key] = o;
    }
  }
  return result;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function assembleConfig(opts: CliOptions): MemoryTdaiConfig {
  const fileCfg = loadConfigFile(opts.configFile);

  const cliOverrides: Record<string, unknown> = {};
  if (opts.llmBaseUrl || opts.llmApiKey || opts.llmModel) {
    cliOverrides.llm = {
      enabled: true,
      ...(opts.llmBaseUrl ? { baseUrl: opts.llmBaseUrl } : {}),
      ...(opts.llmApiKey ? { apiKey: opts.llmApiKey } : {}),
      ...(opts.llmModel ? { model: opts.llmModel } : {}),
    };
  }

  // 回放默认关闭 embedding 与 dedup（dedup 需要 embedding，离线重跑一般不需要）。
  // 但若用户在 --config 里显式配置了 embedding，尊重它（enableDedup 时才能向量召回）。
  // 仅当既未提供 config 文件也未显式开启 dedup 时，才强制 embedding.enabled=false。
  const hasEmbeddingConfig = Boolean(
    (fileCfg as Record<string, unknown>)?.embedding &&
    (fileCfg as Record<string, unknown>).embedding &&
    typeof (fileCfg as Record<string, unknown>).embedding === "object" &&
    ((fileCfg as Record<string, unknown>).embedding as Record<string, unknown>).enabled === true,
  );

  const merged = deepMerge(deepMerge(fileCfg, cliOverrides), {
    extraction: { enableDedup: opts.enableDedup },
    storeBackend: "sqlite",
  });

  if (!hasEmbeddingConfig && !opts.enableDedup) {
    merged.embedding = { enabled: false };
  }

  return parseConfig(merged);
}

// ─────────────────────────────────────────────
// Session listing
// ─────────────────────────────────────────────

/**
 * 从 L0 数据列出 session key。
 * 优先读 SQLite 的 l0_conversations 表；表不存在时从 conversations/*.jsonl 兜底。
 */
async function listSessionKeys(dataDir: string): Promise<string[]> {
  // 尝试 SQLite
  const dbPath = path.join(dataDir, "vectors.db");
  if (fs.existsSync(dbPath)) {
    try {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(dbPath, { open: false });
      db.open();
      db.exec("PRAGMA query_only = ON");
      try {
        const rows = db.prepare("SELECT DISTINCT session_key FROM l0_conversations WHERE session_key != ''").all() as Array<{ session_key: string }>;
        return rows.map((r) => r.session_key).sort();
      } finally {
        db.close();
      }
    } catch {
      // sqlite 模块不可用或表不存在 → 落到 JSONL
    }
  }

  // 兜底：读 conversations/*.jsonl
  const convDir = path.join(dataDir, "conversations");
  const keys = new Set<string>();
  if (fs.existsSync(convDir)) {
    for (const f of fs.readdirSync(convDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const raw = fs.readFileSync(path.join(convDir, f), "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { sessionKey?: string };
          if (parsed.sessionKey) keys.add(parsed.sessionKey);
        } catch { /* malformed line */ }
      }
    }
  }
  return Array.from(keys).sort();
}

// ─────────────────────────────────────────────
// Workdir management
// ─────────────────────────────────────────────

/**
 * 用 SQLite VACUUM INTO 创建一致的向量库快照。
 *
 * 直接 cp 活跃的 WAL 数据库（vectors.db + -wal + -shm）不是原子快照：
 * 分别复制各文件可能读到不一致的时间点。VACUUM INTO 让 SQLite 生成一个
 * 自洽的单一文件副本，等价于静态备份。
 *
 * @param srcDb  源 vectors.db 路径
 * @param destDb 目标快照路径
 * @returns 是否成功（源库不存在 / 非 SQLite / 无 node:sqlite 时返回 false）
 */
async function snapshotSqliteDb(srcDb: string, destDb: string): Promise<boolean> {
  if (!fs.existsSync(srcDb)) return false;
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(srcDb, { open: false });
    db.open();
    try {
      // VACUUM INTO 只能用于主数据库文件，且目标不能已存在。
      if (fs.existsSync(destDb)) fs.rmSync(destDb, { force: true });
      db.exec(`VACUUM INTO '${destDb.replace(/'/g, "''")}'`);
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * 复制数据目录到目标目录，并对 vectors.db 做一致性快照（VACUUM INTO）。
 * 若快照失败（无 node:sqlite / 非 SQLite），退化为普通递归 cp 并警告。
 */
async function copyDataDir(src: string, dest: string): Promise<void> {
  const srcDb = path.join(src, "vectors.db");
  const destDb = path.join(dest, "vectors.db");

  // 先复制除 vectors.db 外的所有内容
  await cp(src, dest, { recursive: true, filter: (s) => path.basename(s) !== "vectors.db" });
  await rm(destDb, { force: true });

  const snapshotted = await snapshotSqliteDb(srcDb, destDb);
  if (snapshotted) {
    logger.info("vectors.db: 已用 VACUUM INTO 生成一致快照");
  } else if (fs.existsSync(srcDb)) {
    logger.warn("vectors.db: 快照失败，已回退到直接复制（活跃 WAL 下可能不一致）");
    await cp(srcDb, destDb);
  }
}

interface PreparedWorkDir {
  /** 实际工作目录路径。 */
  dir: string;
  /** 是否由本工具 mkdtemp 创建。只有这类目录会被自动清理。 */
  createdByUs: boolean;
  /**
   * 清理说明（"临时目录" / "用户指定，保留" / "no-copy，不可清理"），
   * 供日志与最终清理决策使用。
   */
  cleanupPolicy: "temp" | "keep-user" | "never";
}

/**
 * 准备回放工作目录。
 *
 * 安全规则（P0）：
 * - 只有 mkdtemp 创建的临时目录会被自动删除。
 * - 用户用 --work-dir 指定的目录：**永不自动删除**（可能已有数据）。
 * - --no-copy：工作目录就是数据目录，永不删除。
 * - 拒绝 workDir 与 dataDir 相同、或 workDir 是 dataDir 的子目录。
 */
async function prepareWorkDir(opts: CliOptions): Promise<PreparedWorkDir> {
  if (opts.noCopy) {
    logger.warn("--no-copy: 直接在原数据目录上重跑（会写入 L1/L2/L3 数据！）");
    return { dir: opts.dataDir!, createdByUs: false, cleanupPolicy: "never" };
  }

  if (opts.workDir) {
    const work = path.resolve(opts.workDir);
    const data = path.resolve(opts.dataDir!);
    if (work === data) {
      console.error(`❌ --work-dir 不能与 --data-dir 相同（${data}）`);
      console.error("   如需直接重跑原目录，请用 --no-copy");
      process.exit(1);
    }
    if (work.startsWith(data + path.sep) || data.startsWith(work + path.sep)) {
      console.error(`❌ --work-dir 与 --data-dir 不能互为子目录`);
      console.error(`   data-dir: ${data}`);
      console.error(`   work-dir: ${work}`);
      process.exit(1);
    }
    if (!fs.existsSync(work)) {
      await copyDataDir(opts.dataDir!, work);
      logger.info(`已复制数据到用户指定工作目录: ${work}`);
    } else {
      logger.info(`复用已存在的工作目录: ${work}（不复制）`);
    }
    // 用户指定的目录无论是否新建，都不得自动删除。
    return { dir: work, createdByUs: false, cleanupPolicy: "keep-user" };
  }

  const base = await mkdtemp(path.join(tmpdir(), "replay-"));
  await copyDataDir(opts.dataDir!, base);
  return { dir: base, createdByUs: true, cleanupPolicy: "temp" };
}

// ─────────────────────────────────────────────
// Compare
// ─────────────────────────────────────────────

function loadReport(file: string): ReplayReport {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`❌ 报告文件不存在: ${resolved}`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf-8")) as ReplayReport;
  } catch (err) {
    console.error(`❌ 解析报告失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `…(+${s.length - maxLen})`;
}

function compareReports(aPath: string, bPath: string): void {
  const a = loadReport(aPath);
  const b = loadReport(bPath);

  console.log(`\n📼  报告对比: ${path.basename(aPath)}  vs  ${path.basename(bPath)}`);
  console.log(`    A: ${a.llm.baseUrl} / ${a.llm.model}`);
  console.log(`    B: ${b.llm.baseUrl} / ${b.llm.model}\n`);

  const stages = ["L1", "L2", "L3"] as const;
  for (const stage of stages) {
    const aRes = a.results?.[stage];
    const bRes = b.results?.[stage];
    console.log(`${"─".repeat(56)}`);
    console.log(`📊  Stage ${stage}`);
    if (!aRes && !bRes) { console.log("   (两份报告都未包含此阶段)"); continue; }
    if (!aRes) { console.log("   (A 未包含此阶段)"); continue; }
    if (!bRes) { console.log("   (B 未包含此阶段)"); continue; }

    const aCalls = aRes.llmCalls ?? [];
    const bCalls = bRes.llmCalls ?? [];
    console.log(`   LLM 调用数: A=${aCalls.length}  B=${bCalls.length}`);
    if (aRes.status || bRes.status) {
      console.log(`   Status: A=${aRes.status ?? "-"}  B=${bRes.status ?? "-"}`);
    }

    for (let i = 0; i < Math.max(aCalls.length, bCalls.length); i++) {
      const ac = aCalls[i];
      const bc = bCalls[i];
      if (!ac && !bc) continue;
      console.log(`   ── call #${i + 1}: ${ac?.taskId ?? bc?.taskId} ──`);
      if (ac) console.log(`      A [${ac.durationMs}ms]: ${truncate(ac.response, 300)}`);
      if (bc) console.log(`      B [${bc.durationMs}ms]: ${truncate(bc.response, 300)}`);
      if (ac && bc && ac.response !== bc.response) {
        console.log(`      ⚠️  响应不一致`);
      }
    }

    // 各阶段专属 detail 对比
    const aDetail = aRes.detail ?? {};
    const bDetail = bRes.detail ?? {};
    const keys = new Set([...Object.keys(aDetail), ...Object.keys(bDetail)]);
    for (const key of keys) {
      const av = JSON.stringify(aDetail[key]);
      const bv = JSON.stringify(bDetail[key]);
      const same = av === bv;
      console.log(`      ${key}: A=${truncate(av, 160)}  B=${truncate(bv, 160)}  ${same ? "✓" : "✗ 不同"}`);
    }
  }
  console.log(`\n${"─".repeat(56)}`);
}

// ─────────────────────────────────────────────
// Snapshot helpers
// ─────────────────────────────────────────────

/** 简单脱敏：邮箱 / 手机号 / 常见密钥形态。 */
function redactText(input: string): string {
  return input
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b1[3-9]\d{9}\b/g, "[phone]")
    .replace(/(sk-[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "[key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer [key]");
}

function redactRecordedCall(call: RecordedLlmCall): RecordedLlmCall {
  if (!call) return call;
  return {
    ...call,
    systemPrompt: call.systemPrompt ? redactText(call.systemPrompt) : "",
    prompt: call.prompt ? redactText(call.prompt) : "",
    response: call.response ? redactText(call.response) : "",
  };
}

function redactReport(report: ReplayReport): ReplayReport {
  const copy: ReplayReport = JSON.parse(JSON.stringify(report));
  copy.redacted = true;
  for (const stage of ["L1", "L2", "L3"] as const) {
    const res = copy.results?.[stage];
    if (res?.llmCalls) {
      res.llmCalls = res.llmCalls.map(redactRecordedCall);
    }
  }
  return copy;
}

/** 阶段内是否有 LLM 调用失败（runner 内部会吞掉失败，不抛异常，只能用此信号判断）。 */
function hasFailedLlmCalls(calls: RecordedLlmCall[]): boolean {
  return calls.some((c) => c.success === false);
}

// ─────────────────────────────────────────────
// Profile scope helpers (L2/L3 write to profiles/<encoded scope>/)
// ─────────────────────────────────────────────

/** scope 名 → storage key 前缀（legacy 根目录为空字符串）。 */
function profileStoragePrefix(scope: string): string {
  return scope === DEFAULT_PROFILE_SCOPE ? "" : `profiles/${encodeURIComponent(scope)}/`;
}

/** scope 名 → 本地 fs 目录。 */
function profileDir(workDir: string, scope: string): string {
  return scope === DEFAULT_PROFILE_SCOPE ? workDir : path.join(workDir, "profiles", encodeURIComponent(scope));
}

/**
 * 枚举数据目录下的全部 profile scope。
 * - 总是包含 legacy 根目录（DEFAULT_PROFILE_SCOPE，key "global"）。
 * - 其余来自 profiles/ 下的子目录名（URL-decode 后作为 scope 名）。
 */
function listProfileScopes(workDir: string): string[] {
  const scopes = new Set<string>([DEFAULT_PROFILE_SCOPE]);
  const profilesDir = path.join(workDir, "profiles");
  if (fs.existsSync(profilesDir)) {
    for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        scopes.add(decodeURIComponent(entry.name));
      } catch { /* 非 URL 编码的目录名跳过 */ }
    }
  }
  return Array.from(scopes).sort();
}

/** 读某 scope 的 scene 文件列表。 */
function readSceneFilenamesIn(scopeDir: string): string[] {
  const dir = path.join(scopeDir, StoragePaths.sceneBlocksDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

/** 读某 scope 的 persona 内容。 */
function readPersonaIn(scopeDir: string): string {
  const p = path.join(scopeDir, StoragePaths.persona);
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf-8");
}

/** 读某 scope 的 L2 cursor（pipeline_states[l2CursorKey].l2_last_extraction_time）。 */
async function readL2Cursor(scopeDir: string, l2CursorKey: string, logger: PipelineLogger): Promise<string | undefined> {
  try {
    const cpManager = new CheckpointManager(scopeDir, logger);
    const cp = await cpManager.read();
    const state = cp.pipeline_states?.[l2CursorKey];
    return state?.l2_last_extraction_time || undefined;
  } catch {
    return undefined;
  }
}

/** 写回某 scope 的 L2 cursor。 */
async function writeL2Cursor(scopeDir: string, l2CursorKey: string, latestCursor: string, logger: PipelineLogger): Promise<void> {
  if (!latestCursor) return;
  try {
    const cpManager = new CheckpointManager(scopeDir, logger);
    const partial: PipelineSessionState = {
      conversation_count: 0,
      last_extraction_time: "",
      last_extraction_updated_time: "",
      last_active_time: Date.now(),
      l2_pending_l1_count: 0,
      warmup_threshold: 0,
      l2_last_extraction_time: latestCursor,
    };
    await cpManager.mergePipelineStates({ [l2CursorKey]: partial });
  } catch { /* best effort */ }
}

// ─────────────────────────────────────────────
// Clean derived state (isolated rebuild)
// ─────────────────────────────────────────────

/** 单个 scope 内清理 L2/L3（scene_blocks + persona + scene_index + checkpoint 中 L2 相关字段）。 */
async function cleanScopeL2L3(scopeDir: string, logger: PipelineLogger): Promise<void> {
  const prefix = scopeDir; // 该 scope 已是目录

  // scene_blocks/
  const scenesDir = path.join(prefix, StoragePaths.sceneBlocksDir);
  if (fs.existsSync(scenesDir)) {
    let count = 0;
    for (const f of fs.readdirSync(scenesDir)) {
      if (f.endsWith(".md")) {
        try { fs.unlinkSync(path.join(scenesDir, f)); count++; } catch { /* best effort */ }
      }
    }
    logger.info(`  已清空 ${count} 个 scene block（${path.relative(process.cwd(), prefix) || "."}）`);
  }

  // persona.md
  try {
    const p = path.join(prefix, StoragePaths.persona);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* best effort */ }

  // scene_index.json
  try {
    const idx = path.join(prefix, StoragePaths.sceneIndex);
    if (fs.existsSync(idx)) fs.unlinkSync(idx);
  } catch { /* best effort */ }
}

/**
 * 按依赖关系清理派生数据。
 *
 * 语义（依赖感知）：
 * - L1 阶段：清理目标范围的 L1 记录 + 落盘 JSONL + checkpoint，以及全部
 *   下游 L2/L3（scene_blocks / persona），因为它们基于旧 L1 生成。
 * - 只跑 L2：保留 L1，只清理各 scope 的 scene_blocks + persona。
 * - 只跑 L3：保留 L1/L2，只清理各 scope 的 persona。
 *
 * 保留 L0（conversations/*.jsonl 与 l0_conversations 表），因为它是重跑输入源。
 */
async function cleanDerivedState(
  workDir: string,
  vectorStore: import("../../src/core/store/types.js").IMemoryStore,
  logger: PipelineLogger,
  stages: Array<"L1" | "L2" | "L3">,
  scopes: string[],
): Promise<void> {
  const cleanL1 = stages.includes("L1");
  const cleanL2L3 = stages.includes("L2") || stages.includes("L3");
  const cleanPersonaOnly = stages.length === 1 && stages[0] === "L3";

  logger.info(`--clean: 清理派生数据（stages=${stages.join(",")}, L1=${cleanL1}, L2/L3=${cleanL2L3}, personaOnly=${cleanPersonaOnly}）...`);

  // L1：SQLite 记录 + records/*.jsonl + checkpoint
  if (cleanL1) {
    try {
      const rows = await vectorStore.queryL1Records({});
      const ids = rows.map((r) => r.record_id);
      if (ids.length > 0) {
        vectorStore.deleteL1Batch(ids);
        logger.info(`  已清空 ${ids.length} 条 L1 记录`);
      } else {
        logger.info("  无 L1 记录可清理");
      }
    } catch (err) {
      logger.warn(`  清空 L1 记录失败（非致命）: ${err instanceof Error ? err.message : String(err)}`);
    }

    // records/*.jsonl（L1 落盘镜像）
    const recordsDir = path.join(workDir, StoragePaths.recordsDir);
    if (fs.existsSync(recordsDir)) {
      for (const f of fs.readdirSync(recordsDir)) {
        if (f.endsWith(".jsonl")) {
          try { fs.unlinkSync(path.join(recordsDir, f)); } catch { /* best effort */ }
        }
      }
    }

    // checkpoint（含 L1 cursor + 全局状态）
    try {
      const cp = path.join(workDir, StoragePaths.checkpoint);
      if (fs.existsSync(cp)) fs.unlinkSync(cp);
    } catch { /* best effort */ }
  }

  // L2/L3：按 scope 清理 scene_blocks / persona
  if (cleanL2L3) {
    for (const scope of scopes) {
      const scopeDir = profileDir(workDir, scope);
      if (!fs.existsSync(scopeDir)) continue;
      if (cleanPersonaOnly) {
        // 只跑 L3：保留 scene blocks，只删 persona
        try {
          const p = path.join(scopeDir, StoragePaths.persona);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch { /* best effort */ }
      } else {
        await cleanScopeL2L3(scopeDir, logger);
      }
    }
  }
}

// ─────────────────────────────────────────────
// Atomic write with 0600
// ─────────────────────────────────────────────

/**
 * 原子写入报告并强制 0600 权限：
 * 先写随机临时文件（0600）→ fsync → rename 覆盖目标 → 再 chmod 兜底。
 * 覆盖已存在且权限更宽的文件时，目标仍会被收紧到 0600。
 */
async function atomicWriteReport(outputPath: string, content: string): Promise<void> {
  const dir = path.dirname(outputPath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.replay-report.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    await fs.promises.writeFile(tmp, content, { encoding: "utf-8", mode: 0o600 });
    await fs.promises.rename(tmp, outputPath);
  } catch (err) {
    try { await rm(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  // rename 会保留 tmp 的 0600 权限，但再 chmod 一次兜底（如目标已存在且被 rename 影响）。
  try {
    await chmod(outputPath, 0o600);
  } catch { /* best effort */ }
}

// ─────────────────────────────────────────────
// Main replay execution
// ─────────────────────────────────────────────

async function runReplay(opts: CliOptions): Promise<number> {
  const dataDir = opts.dataDir!;

  // ── 0. list-sessions 模式 ──
  if (opts.listSessions) {
    const keys = await listSessionKeys(dataDir);
    console.log(`\n📁  数据目录: ${dataDir}`);
    if (keys.length === 0) {
      console.log("   （未发现任何 session）");
    } else {
      console.log(`   共 ${keys.length} 个 session:`);
      for (const k of keys) console.log(`   · ${k}`);
    }
    console.log();
    return 0;
  }

  // ── 校验 LLM 配置 ──
  const cfg = assembleConfig(opts);
  if (!cfg.llm.enabled || !cfg.llm.apiKey) {
    throw new Error("需要 LLM 配置：--llm-base-url / --llm-api-key / --llm-model（或用 --config 指定配置文件）");
  }

  // ── 1. 准备工作目录（P0：只自动清理 mkdtemp 创建的目录） ──
  const prepared = await prepareWorkDir(opts);
  const workDir = prepared.dir;
  logger.info(`工作目录: ${workDir}（清理策略: ${prepared.cleanupPolicy}）`);

  let vectorStore: import("../../src/core/store/types.js").IMemoryStore | undefined;
  try {
    // ── 收集 session keys ──
    let sessionKeys: string[];
    if (opts.sessionKey) {
      sessionKeys = [opts.sessionKey];
    } else {
      sessionKeys = await listSessionKeys(dataDir);
    }
    if (sessionKeys.length === 0) {
      throw new Error("未发现任何 session（--list-sessions 可查看；或用 --session-key 指定）");
    }
    logger.info(`待重跑 session: ${sessionKeys.join(", ")}`);
    logger.info(`重跑层级: ${opts.stages.join(" → ")} (dedup=${cfg.extraction.enableDedup}, clean=${opts.clean})`);

    // ── 2. 初始化 store（在工作目录上） ──
    const stores = await initStores(cfg, workDir, logger);
    vectorStore = stores.vectorStore;
    if (!vectorStore) {
      throw new Error("Store 初始化失败（工作目录可能缺少 vectors.db）");
    }
    logger.info(`Store 就绪: backend=${cfg.storeBackend}, degraded=${vectorStore.isDegraded()}`);

    const storage = new StorageAdapter(new LocalStorageBackend(workDir));

    // ── 枚举 profile scopes（L2/L3 落盘位置） ──
    const scopes = listProfileScopes(workDir);
    logger.info(`profile scopes: ${scopes.join(", ")}`);

    // ── 3. clean 模式：依赖感知清理派生数据，做隔离的 L0→L3 重建 ──
    if (opts.clean && !opts.keepState) {
      await cleanDerivedState(workDir, vectorStore, logger, opts.stages, scopes);
    }

    // ── 4. 录制 LLM runner ──
    const llmCalls: RecordedLlmCall[] = [];
    const standaloneFactory = new StandaloneLLMRunnerFactory({
      config: {
        baseUrl: cfg.llm.baseUrl,
        apiKey: cfg.llm.apiKey,
        model: cfg.llm.model,
        maxTokens: cfg.llm.maxTokens,
        timeoutMs: cfg.llm.timeoutMs,
      },
      logger,
    });
    const recordingFactory = new RecordingLLMRunnerFactory(standaloneFactory, llmCalls, "replay");
    const l1RunnerInstance = recordingFactory.createRunner({ enableTools: false });
    const l2l3RunnerInstance = recordingFactory.createRunner({ enableTools: true });

    const report: ReplayReport = {
      tool: "replay-pipeline",
      version: "1.2.0",
      createdAt: new Date().toISOString(),
      dataDir,
      workDir: opts.noCopy ? undefined : workDir,
      sessionKey: opts.sessionKey,
      stages: opts.stages,
      llm: { baseUrl: cfg.llm.baseUrl, model: cfg.llm.model },
      enableDedup: cfg.extraction.enableDedup,
      clean: opts.clean && !opts.keepState,
      redacted: opts.redact,
      failed: false,
      results: {},
      profiles: {},
    };

    let anyFailed = false;

    // ── L1 ──
    if (opts.stages.includes("L1")) {
      logger.info(`\n[L1] 开始原子抽取...`);
      const l1Before = Date.now();
      const l1Runner = createL1Runner({
        pluginDataDir: workDir,
        cfg,
        openclawConfig: undefined,
        vectorStore,
        embeddingService: stores.embeddingService,
        logger,
        llmRunner: l1RunnerInstance,
        storage,
      });

      let processedCount = 0;
      let storedCount = 0;
      let l1Failed = false;
      const l1Errors: string[] = [];

      // 生产 runner 每轮最多处理 L1_BATCH_PROCESS=10 条 L0，且返回 hasMore /
      // hasFullBacklog 指示是否有积压。这里循环直到两个标志都为 false，
      // 确保历史消息超过一个批次时全部处理（P1）。
      const MAX_L1_ROUNDS = 10000;
      for (const key of sessionKeys) {
        let rounds = 0;
        for (;;) {
          try {
            const result = await l1Runner({ sessionKey: key });
            processedCount += result?.processedCount ?? 0;
            storedCount += result?.storedCount ?? 0;
            const more = (result?.hasMore === true) || (result?.hasFullBacklog === true);
            rounds++;
            if (!more) break;
            if (rounds >= MAX_L1_ROUNDS) {
              l1Errors.push(`session ${key}: 达到最大批次上限 ${MAX_L1_ROUNDS}，可能有积压未处理`);
              l1Failed = true;
              break;
            }
          } catch (err) {
            l1Failed = true;
            l1Errors.push(`session ${key}: ${err instanceof Error ? err.message : String(err)}`);
            logger.warn(`[L1] session ${key} 失败（继续下一个）: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
        }
      }

      // 读取本次抽取后 L1 记录数（快照）
      let l1Count = 0;
      try { l1Count = await vectorStore.countL1(); } catch { /* ok */ }

      const l1Calls = llmCalls.filter((c) => c.taskId === "l1-extraction" || c.taskId === "l1-conflict-detection");
      // runner 内部会吞掉 LLM 失败（不抛异常），所以除了异常，还要检查录制到的调用是否失败。
      const l1LlmFailed = hasFailedLlmCalls(l1Calls);
      const l1FinalFailed = l1Failed || l1LlmFailed;

      report.results.L1 = {
        llmCalls: l1Calls,
        detail: {
          sessions: sessionKeys,
          processedCount,
          storedCount,
          totalL1Count: l1Count,
          durationMs: Date.now() - l1Before,
          ...(l1Errors.length > 0 ? { errors: l1Errors } : {}),
        },
        status: l1FinalFailed ? "failed" : "ok",
      };
      if (l1FinalFailed) anyFailed = true;
      logger.info(`[L1] 完成: processed=${processedCount}, stored=${storedCount}, total L1=${l1Count} (${Date.now() - l1Before}ms)`);
    }

    // ── L2 ──
    if (opts.stages.includes("L2")) {
      logger.info(`\n[L2] 开始场景抽取...`);
      const l2Before = Date.now();
      const l2Runner = createL2Runner({
        pluginDataDir: workDir,
        cfg,
        openclawConfig: undefined,
        vectorStore,
        logger,
        llmRunner: l2l3RunnerInstance,
        storage,
      });

      let l2Failed = false;
      const l2Errors: string[] = [];

      // --keep-state：L2 增量依赖 cursor。生产环境 L2 cursor 存在
      // pipeline_states[l2CursorKey].l2_last_extraction_time；这里按 scope 读取并传入，
      // runner 返回 latestCursor 后再写回（scopedDataDir 与 runner 内部一致）。
      for (const key of sessionKeys) {
        try {
          // L2 的 cursor key：生产 pipeline-manager 用 sessionKey（含 profile: 前缀或裸 session）。
          // 这里对每个 scope 用裸 sessionKey 作为 cursor key，与 scopedDataDirForScope 对应。
          const cursor = opts.keepState ? await readL2Cursor(workDir, key, logger) : undefined;
          const result = await l2Runner(key, cursor);
          if (result?.latestCursor) {
            await writeL2Cursor(workDir, key, result.latestCursor, logger);
          }
        } catch (err) {
          l2Failed = true;
          l2Errors.push(`session ${key}: ${err instanceof Error ? err.message : String(err)}`);
          logger.warn(`[L2] session ${key} 失败（继续）: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 按 scope 快照 scenes
      const l2Calls = llmCalls.filter((c) => c.taskId.startsWith("scene-extract"));
      const l2FinalFailed = l2Failed || hasFailedLlmCalls(l2Calls);
      let scenesBeforeTotal = 0;
      let scenesAfterTotal = 0;
      for (const scope of scopes) {
        const scopeDir = profileDir(workDir, scope);
        const before = readSceneFilenamesIn(scopeDir);
        // 场景抽取后重新读取（clean 时 before 为空）
        const after = readSceneFilenamesIn(scopeDir);
        scenesBeforeTotal += before.length;
        scenesAfterTotal += after.length;
        if (report.profiles) {
          const existing = report.profiles[scope] ?? {
            scenesBefore: [],
            scenesAfter: [],
            personaBeforeChars: 0,
            personaAfterChars: 0,
            personaChanged: false,
          };
          existing.scenesBefore = before;
          existing.scenesAfter = after;
          report.profiles[scope] = existing;
        }
      }

      report.results.L2 = {
        llmCalls: l2Calls,
        detail: {
          sessions: sessionKeys,
          scopes,
          scenesBeforeTotal,
          scenesAfterTotal,
          durationMs: Date.now() - l2Before,
          ...(l2Errors.length > 0 ? { errors: l2Errors } : {}),
        },
        status: l2FinalFailed ? "failed" : "ok",
      };
      if (l2FinalFailed) anyFailed = true;
      logger.info(`[L2] 完成: scenes ${scenesBeforeTotal} → ${scenesAfterTotal} (${Date.now() - l2Before}ms)`);
    }

    // ── L3 ──
    if (opts.stages.includes("L3")) {
      logger.info(`\n[L3] 开始 Persona 生成...`);
      const l3Before = Date.now();
      const l3Runner = createL3Runner({
        pluginDataDir: workDir,
        cfg,
        openclawConfig: undefined,
        vectorStore,
        logger,
        llmRunner: l2l3RunnerInstance,
        storage,
      });

      let l3Failed = false;
      const l3Errors: string[] = [];
      try {
        await l3Runner();
      } catch (err) {
        l3Failed = true;
        l3Errors.push(err instanceof Error ? err.message : String(err));
        logger.warn(`[L3] 失败: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 按 scope 快照 persona
      const l3Calls = llmCalls.filter((c) => c.taskId === "persona-generation");
      const l3FinalFailed = l3Failed || hasFailedLlmCalls(l3Calls);
      let personaBeforeTotal = 0;
      let personaAfterTotal = 0;
      for (const scope of scopes) {
        const scopeDir = profileDir(workDir, scope);
        const before = readPersonaIn(scopeDir);
        const after = readPersonaIn(scopeDir);
        personaBeforeTotal += before.length;
        personaAfterTotal += after.length;
        if (report.profiles) {
          const existing = report.profiles[scope] ?? {
            scenesBefore: [],
            scenesAfter: [],
            personaBeforeChars: 0,
            personaAfterChars: 0,
            personaChanged: false,
          };
          existing.personaBeforeChars = before.length;
          existing.personaAfterChars = after.length;
          existing.personaChanged = before !== after;
          report.profiles[scope] = existing;
        }
      }

      report.results.L3 = {
        llmCalls: l3Calls,
        detail: {
          scopes,
          personaBeforeTotal,
          personaAfterTotal,
          durationMs: Date.now() - l3Before,
          ...(l3Errors.length > 0 ? { errors: l3Errors } : {}),
        },
        status: l3FinalFailed ? "failed" : "ok",
      };
      if (l3FinalFailed) anyFailed = true;
      logger.info(`[L3] 完成: persona ${personaBeforeTotal} → ${personaAfterTotal} chars (${Date.now() - l3Before}ms)`);
    }

    report.failed = anyFailed;

    // ── 6. 写报告（可选脱敏；原子写入 + 强制 0600） ──
    const finalReport = opts.redact ? redactReport(report) : report;
    await atomicWriteReport(opts.output, JSON.stringify(finalReport, null, 2));
    console.log(`\n✅ 报告已写入: ${opts.output}（${opts.redact ? "已脱敏" : "未脱敏"}，含完整对话内容，注意保管）`);
    console.log(`   共录制 ${llmCalls.length} 次 LLM 调用`);
    if (anyFailed) {
      console.log(`\n⚠️  部分阶段失败（详见报告各 stage.status），退出码为 1`);
    }

    return anyFailed ? 1 : 0;
  } finally {
    // ── 5. 关闭 store（先于目录清理） ──
    if (vectorStore) {
      try { resetStores(workDir); } catch { /* ok */ }
      try { vectorStore.close(); } catch { /* ok */ }
    }

    // ── 7. 清理工作目录：只清理 mkdtemp 创建的临时目录。
    //    即使中途抛异常，这里也会执行（异常路径不残留敏感副本）。 ──
    if (prepared.createdByUs) {
      if (opts.keepWorkDir) {
        logger.info(`临时工作目录已保留: ${workDir}`);
      } else {
        try {
          await rm(workDir, { recursive: true, force: true });
          logger.info(`已清理临时工作目录: ${workDir}`);
        } catch { /* best effort */ }
      }
    } else {
      logger.info(`工作目录非本工具创建，已保留: ${workDir}`);
    }
  }
}

// ─────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCli();

  if (opts.compare) {
    compareReports(opts.compare[0], opts.compare[1]);
    return;
  }

  const exitCode = await runReplay(opts);
  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(`\n❌ 回放失败: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
