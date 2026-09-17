/**
 * Structured logger for context-proxy.
 *
 * Provides:
 * 1. JSONL file logging for usage events (daily rotation by date)
 * 2. Console pipeline logging with timing — traces the full message processing path:
 *    request → forward → response (stream/non-stream) → usage
 *
 * Note: General structured logging (info/warn/error/debug) is handled by
 * the new report module (src/report/log.ts). This file only keeps the
 * JSONL usage logger and the pipeline tracker for backward compatibility.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { LogEntry, ProxyConfig } from "./types.js";
import { log } from "./report/log.js";
import { writeClickHouse } from "./clickhouse.js";

// ── JSONL file logger (usage events only) ─────────────────────────────────────

/** Cache of directories that have been ensured to exist. */
const ensuredDirs = new Set<string>();

/** Get today's log file path: logs/YYYY-MM-DD.jsonl (relative to config.log.file base dir). */
function getDailyLogPath(baseDir: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return resolve(baseDir, `${date}.jsonl`);
}

/** Ensure the directory exists (cached to avoid repeated syscalls). */
async function ensureDir(dir: string): Promise<void> {
  if (ensuredDirs.has(dir)) return;
  await mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

/** Append a single usage log entry as a JSON line. Fire-and-forget (no await needed). */
export function writeLog(config: ProxyConfig, entry: LogEntry): void {
  // ── ClickHouse async write (if enabled) ──────────────────────────────────
    if (config.clickhouse.enabled && (entry.event === "usage" || entry.event === "analyzer_usage")) {
    writeClickHouse({
      timestamp: entry.timestamp,
      event: entry.event,
      modelId: entry.modelId,
      keyId: entry.keyId,
      sessionKey: entry.sessionKey,
      turnSeq: "turnSeq" in entry ? entry.turnSeq : undefined,
      userInput: "userInput" in entry ? entry.userInput : undefined,
      upstreamUrl: entry.upstreamUrl,
      stream: entry.stream,
      usage: entry.usage,
      routedFrom: "routedFrom" in entry ? entry.routedFrom : undefined,
      spaceId: "spaceId" in entry ? entry.spaceId : undefined,
      upstreamRequestId:
        "upstreamRequestId" in entry ? entry.upstreamRequestId : undefined,
      extensionStats:
        "extensionStats" in entry ? entry.extensionStats : undefined,
      pricingConfig: config.creditPricing,
    });
  }

  // ── JSONL file write ─────────────────────────────────────────────────────
  if (!config.log.file) return;

  const logPath = getDailyLogPath(config.log.file);
  const dir = dirname(logPath);

  const line = JSON.stringify(entry) + "\n";
  ensureDir(dir)
    .then(() => appendFile(logPath, line, "utf-8"))
    .catch((err: unknown) => {
      log.error("usage_log.write_failed", { path: logPath }, err instanceof Error ? err : new Error(String(err)));
    });
}

// ── Pipeline logger (console) ─────────────────────────────────────────────────

/** Format timestamp as MM-DD HH:MM:SS.mmm for concise console output. */
function ts(): string {
  const now = new Date();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${mo}-${d} ${h}:${mi}:${s}.${ms}`;
}

/** Format elapsed ms into human readable string. */
function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Pipeline tracker — tracks a single request through its full lifecycle.
 *
 * Usage:
 *   const pipe = createPipeline(config, reqId, modelId);
 *   pipe.requestReceived(msgCount, isStream);
 *   pipe.forwardStart();
 *   pipe.forwardDone(status);
 *   pipe.streamStart();
 *   pipe.streamDone(usage);
 *   pipe.responseDone(usage);
 *   pipe.error(stage, err);
 */
export interface Pipeline {
  /** Request received from client. */
  requestReceived(msgCount: number, isStream: boolean): void;
  /** Forwarding to upstream started. */
  forwardStart(upstreamUrl?: string): void;
  /** Upstream responded (initial response received). */
  forwardDone(status: number): void;
  /** Streaming response being forwarded to client. */
  streamStart(): void;
  /** Stream fully consumed, usage extracted. */
  streamDone(usage: Record<string, unknown> | null): void;
  /** Non-stream response fully received. */
  responseDone(usage: Record<string, unknown> | null): void;
  /** Informational message at any stage (non-error). */
  info(stage: string, detail: string): void;
  /** Error at any stage. */
  error(stage: string, err: unknown): void;
  /** Complete pipeline summary. */
  summary(): void;
}

export function createPipeline(
  config: ProxyConfig,
  requestId: string,
  modelId: string,
): Pipeline {
  const pipeStart = Date.now();
  const tag = `[${requestId.slice(0, 8)}]`;
  const stages: string[] = [];
  let forwardMs = 0;
  let forwardStartMs = 0;

  function pipeLog(stage: string, detail: string): void {
    // Also write to stderr for real-time tail observation
    const line = `${ts()} ${tag} ${stage} ${detail}`;
    process.stderr.write(line + "\n");
    stages.push(stage);
  }

  return {
    requestReceived(msgCount, isStream) {
      pipeLog("→ REQ", `model=${modelId} msgs=${msgCount} stream=${isStream}`);
    },

    forwardStart(upstreamUrl?: string) {
      forwardStartMs = Date.now();
      const url = upstreamUrl ?? config.upstream.url;
      log.debug("pipeline.forward.start", { requestId: tag, upstream: url });
      pipeLog("  → FORWARD", `upstream=${url}`);
    },

    forwardDone(status) {
      forwardMs = Date.now() - forwardStartMs;
      pipeLog("  ← FORWARD", `status=${status} ${forwardMs}ms`);
    },

    streamStart() {
      log.debug("pipeline.stream.start", { requestId: tag });
      pipeLog("  ⇄ STREAM", "forwarding to client...");
    },

    streamDone(usage) {
      const total = elapsed(pipeStart);
      if (usage) {
        pipeLog("  ✓ STREAM", `usage: ${JSON.stringify(usage)}`);
      } else {
        pipeLog("  ✓ STREAM", "done (no usage extracted)");
      }
      pipeLog("← DONE", `total=${total}`);
    },

    responseDone(usage) {
      const total = elapsed(pipeStart);
      if (usage) {
        pipeLog("  ✓ RESP", `usage: ${JSON.stringify(usage)}`);
      } else {
        pipeLog("  ✓ RESP", "done (no usage)");
      }
      pipeLog("← DONE", `total=${total}`);
    },

    info(stage, detail) {
      pipeLog(`  ℹ ${stage}`, detail);
    },

    error(stage, err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("pipeline.error", { requestId: tag, stage, error: msg }, err instanceof Error ? err : new Error(msg));
      pipeLog(`  ✗ ${stage}`, msg);
    },

    summary() {
      const total = elapsed(pipeStart);
      const path = stages.join(" → ");
      log.debug("pipeline.summary", { requestId: tag, stages: path, totalMs: Number(total.replace("s", "")) * 1000 || 0, forwardMs });
      pipeLog("  SUMMARY", `path=[${path}] total=${total} forward=${forwardMs}ms`);
    },
  };
}
