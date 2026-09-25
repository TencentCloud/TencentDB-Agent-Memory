/**
 * Trace archive — 本地 JSONL 冷存储。
 *
 * 每个 trace + span 以 JSONL 行写入本地文件，按日期分文件。
 * 可配合 crontab 脚本定时压缩上传到 COS/S3 归档存储。
 *
 * 设计：
 *  - 使用 WriteStream 异步缓冲写入，不阻塞事件循环
 *  - 按 hostname 隔离多实例的归档文件
 *  - Backpressure 处理：缓冲区满时暂停写入，drain 后恢复
 *  - 通过配置项 `traceArchive.enabled` 控制开关，默认关闭
 */

import { createWriteStream, mkdirSync, existsSync, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { log } from "./report/log.js";

/** Host identifier for multi-instance isolation. */
const HOST_ID = hostname();

/** 默认归档文件存放目录 */
const DEFAULT_ARCHIVE_DIR = "logs/traces";

/** Shutdown timeout (ms) — 防止 end() 卡死 */
const SHUTDOWN_TIMEOUT_MS = 5000;

/** WriteStream highWaterMark (bytes) — 64KB buffer */
const HIGH_WATER_MARK = 64 * 1024;

let archiveDir = "";
let enabled = false;
let currentDate = "";
let currentStream: WriteStream | null = null;
let warnedDisabled = false;
let backpressure = false;
let droppedLines = 0;

// ── Public types ─────────────────────────────────────────────────────────────

/** Configuration for trace archive. */
export interface TraceArchiveConfig {
  /** Master switch — 是否启用本地 JSONL 归档。默认 false（关闭）。 */
  enabled: boolean;
  /** 归档目录（相对于项目根目录或绝对路径）。默认 "logs/traces"。 */
  dir: string;
}

/** Archived trace event shape (trace create). */
export interface ArchivedTrace {
  type: "trace";
  id: string;
  name: string;
  projectName: string;
  startTime: string;
  input: unknown;
  tags?: string[];
}

/** Archived span event shape (LLM span). */
export interface ArchivedSpan {
  type: "span";
  id: string;
  traceId: string;
  name: string;
  projectName: string;
  model: string;
  startTime: string;
  endTime: string;
  input: unknown;
  output: unknown;
  usage: Record<string, unknown>;
  tags?: string[];
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * initTraceArchive 初始化 trace 归档系统。
 * 仅当 config.enabled === true 时实际启用写入。
 *
 * @param baseDir 项目根目录（用于解析相对路径）
 * @param config  TraceArchive 配置
 */
export function initTraceArchive(baseDir: string, config: TraceArchiveConfig): void {
  if (!config.enabled) {
    log.info("trace_archive.disabled");
    return;
  }

  const dir = config.dir || DEFAULT_ARCHIVE_DIR;
  archiveDir = resolve(baseDir, dir);
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }
  enabled = true;
  log.info("trace_archive.init", { dir: archiveDir, host: HOST_ID });
}

/**
 * shutdownTraceArchive 关闭归档写入流，确保数据落盘。
 * 在 graceful shutdown 时调用。带 timeout 兜底防止卡死。
 */
export function shutdownTraceArchive(): Promise<void> {
  if (droppedLines > 0) {
    log.warn("trace_archive.dropped_lines", { count: droppedLines });
  }

  return new Promise((resolvePromise) => {
    if (!currentStream) {
      resolvePromise();
      return;
    }

    const stream = currentStream;
    currentStream = null;
    enabled = false;

    // Timeout 兜底：5 秒内没完成就强制 resolve
    const timer = setTimeout(() => {
      log.warn("trace_archive.shutdown_timeout", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      stream.destroy();
      resolvePromise();
    }, SHUTDOWN_TIMEOUT_MS);

    stream.on("error", () => {
      clearTimeout(timer);
      resolvePromise();
    });

    stream.end(() => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * getOrCreateStream 返回当前日期的写入流。
 * 跨天时自动关闭旧流并创建新流。
 */
function getOrCreateStream(): WriteStream | null {
  if (!enabled) return null;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentDate) {
    // 跨天：关闭旧流（fire-and-forget，旧流数据会异步刷盘）
    if (currentStream) {
      const oldStream = currentStream;
      oldStream.end();
    }
    currentDate = today;
    backpressure = false;
    const filePath = join(archiveDir, `${HOST_ID}-${today}.jsonl`);
    currentStream = createWriteStream(filePath, {
      flags: "a",
      encoding: "utf-8",
      highWaterMark: HIGH_WATER_MARK,
    });
    currentStream.on("error", (err) => {
      log.warn("trace_archive.stream_error", { error: err.message });
    });
    currentStream.on("drain", () => {
      backpressure = false;
    });
  }
  return currentStream;
}

/**
 * archiveLine 追加一行 JSON 到归档文件。
 * 使用 WriteStream 异步缓冲写入，不阻塞事件循环。
 * 处理 backpressure：缓冲区满时丢弃新数据并记录计数。
 */
function archiveLine(line: string): void {
  if (!enabled) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      // 如果调用方在未启用时调用，静默跳过（配置项默认关闭是正常情况）
    }
    return;
  }

  // Backpressure: 缓冲区满时丢弃（best-effort 归档）
  if (backpressure) {
    droppedLines++;
    return;
  }

  const stream = getOrCreateStream();
  if (stream) {
    const ok = stream.write(line + "\n");
    if (!ok) {
      backpressure = true;
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * archiveTrace 归档一条 trace 创建事件。
 * 异常安全：JSON.stringify 或写入失败不会抛出。
 * 当 traceArchive.enabled = false 时为 no-op。
 */
export function archiveTrace(trace: ArchivedTrace): void {
  if (!enabled) return;
  try {
    archiveLine(JSON.stringify(trace));
  } catch (err: unknown) {
    log.warn("trace_archive.serialize_error", {
      type: "trace",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * archiveSpan 归档一条 LLM span 事件。
 * 异常安全：JSON.stringify 或写入失败不会抛出。
 * 当 traceArchive.enabled = false 时为 no-op。
 */
export function archiveSpan(span: ArchivedSpan): void {
  if (!enabled) return;
  try {
    archiveLine(JSON.stringify(span));
  } catch (err: unknown) {
    log.warn("trace_archive.serialize_error", {
      type: "span",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
