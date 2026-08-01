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
import { mkdtemp, cp, rm } from "node:fs/promises";
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

interface StageReport {
  /** 本阶段触发的 LLM 调用（原始 prompt / response / 耗时）。 */
  llmCalls: RecordedLlmCall[];
  /** 本阶段额外快照（如 L1 stored count、L2 scene 前后、L3 persona 前后）。 */
  detail: Record<string, unknown>;
  /** 阶段执行结果：ok / failed / skipped。 */
  status: "ok" | "failed" | "skipped";
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
      --work-dir <路径>      指定工作目录（默认临时目录；指定的目录不会被自动删除）
      --no-copy              不复制，直接在原数据目录上重跑（危险！会写数据）
      --keep-workdir         保留临时工作目录不清理
  -o, --output <file>        报告输出 JSON 路径（默认 ./replay-report.json）
      --compare <a> <b>      对比两份报告并打印差异摘要
  -h, --help                 显示帮助

⚠️  报告包含完整对话内容（prompt 与模型输出），注意保管，避免泄露。

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

  return {
    dataDir: resolvedDataDir,
    workDir: values["work-dir"] ? path.resolve(values["work-dir"]) : undefined,
    noCopy: values["no-copy"] === true,
    keepWorkDir: values["keep-workdir"] === true,
    clean,
    keepState,
    redact: values.redact === true,
    listSessions: values["list-sessions"] === true,
    sessionKey: values["session-key"] as string | undefined,
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
      await cp(opts.dataDir!, work, { recursive: true });
      logger.info(`已复制数据到用户指定工作目录: ${work}`);
    } else {
      logger.info(`复用已存在的工作目录: ${work}（不复制）`);
    }
    // 用户指定的目录无论是否新建，都不得自动删除。
    return { dir: work, createdByUs: false, cleanupPolicy: "keep-user" };
  }

  const base = await mkdtemp(path.join(tmpdir(), "replay-"));
  await cp(opts.dataDir!, base, { recursive: true });
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

function readSceneFilenames(workDir: string): string[] {
  const dir = path.join(workDir, StoragePaths.sceneBlocksDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

function readPersona(workDir: string): string {
  const p = path.join(workDir, StoragePaths.persona);
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf-8");
}

// ─────────────────────────────────────────────
// Clean derived state (isolated rebuild)
// ─────────────────────────────────────────────

/**
 * 清空工作目录里的派生数据，做隔离的 L0→L3 重建：
 * - checkpoint / scene_index（metadata 目录内）
 * - L1 记录（l1_records + 向量 + FTS）
 * - scene_blocks/（L2）
 * - persona.md（L3）
 * - records/*.jsonl（L1 落盘）
 *
 * 保留 L0（conversations/*.jsonl 与 l0_conversations 表），因为它是
 * 重跑的输入源。
 */
async function cleanDerivedState(
  workDir: string,
  vectorStore: import("../../src/core/store/types.js").IMemoryStore,
  storage: StorageAdapter,
  logger: PipelineLogger,
): Promise<void> {
  logger.info("--clean: 清空派生数据（L1 记录 / scene_blocks / persona / checkpoint）...");

  // 1. L1 记录：先查全部 id，再 batch 删除（deleteL1Batch 会一并清理向量与 FTS）
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

  // 2. checkpoint + scene_index
  for (const rel of [StoragePaths.checkpoint, StoragePaths.sceneIndex]) {
    try {
      if (await storage.exists(rel)) {
        await storage.unlink(rel);
      }
    } catch { /* best effort */ }
  }

  // 3. scene_blocks/（L2）
  try {
    const names = await storage.readdirNames(StoragePaths.sceneBlocksDir, ".md");
    for (const name of names) {
      try { await storage.unlink(`${StoragePaths.sceneBlocksDir}${name}`); } catch { /* best effort */ }
    }
    logger.info(`  已清空 ${names.length} 个 scene block`);
  } catch { /* 目录不存在则跳过 */ }

  // 4. persona.md（L3）
  try {
    if (await storage.exists(StoragePaths.persona)) {
      await storage.unlink(StoragePaths.persona);
    }
  } catch { /* best effort */ }

  // 5. records/*.jsonl（L1 落盘镜像）
  try {
    const names = await storage.readdirNames(StoragePaths.recordsDir, ".jsonl");
    for (const name of names) {
      try { await storage.unlink(`${StoragePaths.recordsDir}${name}`); } catch { /* best effort */ }
    }
  } catch { /* 目录不存在则跳过 */ }
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
    console.error("❌ 需要 LLM 配置：--llm-base-url / --llm-api-key / --llm-model（或用 --config 指定配置文件）");
    process.exit(1);
  }

  // ── 1. 准备工作目录（P0：只自动清理 mkdtemp 创建的目录） ──
  const prepared = await prepareWorkDir(opts);
  const workDir = prepared.dir;
  logger.info(`工作目录: ${workDir}（清理策略: ${prepared.cleanupPolicy}）`);

  // ── 收集 session keys ──
  let sessionKeys: string[];
  if (opts.sessionKey) {
    sessionKeys = [opts.sessionKey];
  } else {
    sessionKeys = await listSessionKeys(dataDir);
  }
  if (sessionKeys.length === 0) {
    console.error("❌ 未发现任何 session（--list-sessions 可查看；或用 --session-key 指定）");
    process.exit(1);
  }
  logger.info(`待重跑 session: ${sessionKeys.join(", ")}`);
  logger.info(`重跑层级: ${opts.stages.join(" → ")} (dedup=${cfg.extraction.enableDedup}, clean=${opts.clean})`);

  // ── 2. 初始化 store（在工作目录上） ──
  const { vectorStore, embeddingService } = await initStores(cfg, workDir, logger);
  if (!vectorStore) {
    console.error("❌ Store 初始化失败（工作目录可能缺少 vectors.db）");
    process.exit(1);
  }
  logger.info(`Store 就绪: backend=${cfg.storeBackend}, degraded=${vectorStore.isDegraded()}`);

  const storage = new StorageAdapter(new LocalStorageBackend(workDir));

  // ── 3. clean 模式：清空派生数据，做隔离的 L0→L3 重建 ──
  if (opts.clean && !opts.keepState) {
    await cleanDerivedState(workDir, vectorStore, storage, logger);
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
    version: "1.1.0",
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
      embeddingService,
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
    const scenesBefore = readSceneFilenames(workDir);
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
    for (const key of sessionKeys) {
      try {
        await l2Runner(key);
      } catch (err) {
        l2Failed = true;
        l2Errors.push(`session ${key}: ${err instanceof Error ? err.message : String(err)}`);
        logger.warn(`[L2] session ${key} 失败（继续）: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const scenesAfter = readSceneFilenames(workDir);
    const l2Calls = llmCalls.filter((c) => c.taskId.startsWith("scene-extract"));
    const l2FinalFailed = l2Failed || hasFailedLlmCalls(l2Calls);
    report.results.L2 = {
      llmCalls: l2Calls,
      detail: {
        scenesBefore,
        scenesAfter,
        scenesCreated: scenesAfter.filter((s) => !scenesBefore.includes(s)),
        scenesDeleted: scenesBefore.filter((s) => !scenesAfter.includes(s)),
        durationMs: Date.now() - l2Before,
        ...(l2Errors.length > 0 ? { errors: l2Errors } : {}),
      },
      status: l2FinalFailed ? "failed" : "ok",
    };
    if (l2FinalFailed) anyFailed = true;
    logger.info(`[L2] 完成: scenes ${scenesBefore.length} → ${scenesAfter.length} (${Date.now() - l2Before}ms)`);
  }

  // ── L3 ──
  if (opts.stages.includes("L3")) {
    logger.info(`\n[L3] 开始 Persona 生成...`);
    const personaBefore = readPersona(workDir);
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

    const personaAfter = readPersona(workDir);
    const l3Calls = llmCalls.filter((c) => c.taskId === "persona-generation");
    const l3FinalFailed = l3Failed || hasFailedLlmCalls(l3Calls);
    report.results.L3 = {
      llmCalls: l3Calls,
      detail: {
        personaBeforeChars: personaBefore.length,
        personaAfterChars: personaAfter.length,
        personaChanged: personaBefore !== personaAfter,
        durationMs: Date.now() - l3Before,
        ...(l3Errors.length > 0 ? { errors: l3Errors } : {}),
      },
      status: l3FinalFailed ? "failed" : "ok",
    };
    if (l3FinalFailed) anyFailed = true;
    logger.info(`[L3] 完成: persona ${personaBefore.length} → ${personaAfter.length} chars (${Date.now() - l3Before}ms)`);
  }

  report.failed = anyFailed;

  // ── 5. 关闭 store，清理缓存 ──
  try { resetStores(workDir); } catch { /* ok */ }
  try { vectorStore.close(); } catch { /* ok */ }

  // ── 6. 写报告（可选脱敏；严格权限 0600） ──
  const finalReport = opts.redact ? redactReport(report) : report;
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, JSON.stringify(finalReport, null, 2), { encoding: "utf-8", mode: 0o600 });
  console.log(`\n✅ 报告已写入: ${opts.output}（${opts.redact ? "已脱敏" : "未脱敏"}，含完整对话内容，注意保管）`);
  console.log(`   共录制 ${llmCalls.length} 次 LLM 调用`);
  if (anyFailed) {
    console.log(`\n⚠️  部分阶段失败（详见报告各 stage.status），退出码为 1`);
  }

  // ── 7. 清理工作目录：只清理 mkdtemp 创建的临时目录 ──
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

  return anyFailed ? 1 : 0;
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
