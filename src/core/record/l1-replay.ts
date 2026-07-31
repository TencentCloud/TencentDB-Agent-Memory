import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryTdaiConfig } from "../../config.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { readConversationMessagesGroupedBySessionId } from "../conversation/l0-recorder.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, L0QueryRow } from "../store/types.js";
import type { LLMRunner, Logger } from "../types.js";
import { extractL1Memories } from "./l1-extractor.js";

const TAG = "[memory-tdai][l1-replay]";
const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 500;
export const L1_REPLAY_RECEIPT_PATH = ".metadata/l1-replay-receipts.jsonl";

export interface L1ReplayRequest {
  sessionKey: string;
  fromRecordedAtMs?: number;
  toRecordedAtMs?: number;
  limit?: number;
  dryRun?: boolean;
}

export type L1ReplayStatus = "dry-run" | "completed" | "failed" | "skipped";

export interface L1ReplayReceipt {
  replayId: string;
  fingerprint: string;
  sessionKey: string;
  status: L1ReplayStatus;
  dryRun: boolean;
  fromRecordedAtMs?: number;
  toRecordedAtMs?: number;
  limit: number;
  l0RecordIds: string[];
  attemptedCount: number;
  groupCount: number;
  successfulGroups: number;
  extractedCount: number;
  storedCount: number;
  checkpointCursorBefore: number;
  checkpointCursorAfter: number;
  startedAt: string;
  completedAt: string;
  reusedReceiptId?: string;
  error?: string;
}

export class L1ReplayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "L1ReplayValidationError";
  }
}

export class L1ReplayExecutionError extends Error {
  readonly receipt: L1ReplayReceipt;

  constructor(message: string, receipt: L1ReplayReceipt) {
    super(message);
    this.name = "L1ReplayExecutionError";
    this.receipt = receipt;
  }
}

export interface L1ReplayDependencies {
  baseDir: string;
  cfg: MemoryTdaiConfig;
  config?: unknown;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  llmRunner: LLMRunner;
  logger: Logger;
  instanceId?: string;
}

export async function replayL1(
  request: L1ReplayRequest,
  deps: L1ReplayDependencies,
): Promise<L1ReplayReceipt> {
  const normalized = normalizeRequest(request);
  const startedAt = new Date().toISOString();
  const checkpoint = new CheckpointManager(deps.baseDir, deps.logger);
  const checkpointBefore = await checkpoint.read();
  const cursorBefore = checkpoint.getRunnerState(checkpointBefore, normalized.sessionKey).last_l1_cursor;
  const rows = await readReplayRows(normalized, deps);
  const l0RecordIds = rows.map((row) => row.record_id);
  const fingerprint = replayFingerprint(normalized, l0RecordIds);
  const baseReceipt = {
    replayId: randomUUID(),
    fingerprint,
    sessionKey: normalized.sessionKey,
    dryRun: normalized.dryRun,
    fromRecordedAtMs: normalized.fromRecordedAtMs,
    toRecordedAtMs: normalized.toRecordedAtMs,
    limit: normalized.limit,
    l0RecordIds,
    attemptedCount: rows.length,
    groupCount: 0,
    successfulGroups: 0,
    extractedCount: 0,
    storedCount: 0,
    checkpointCursorBefore: cursorBefore,
    checkpointCursorAfter: cursorBefore,
    startedAt,
  };

  if (normalized.dryRun) {
    const groups = groupRows(rows);
    return {
      ...baseReceipt,
      status: "dry-run",
      groupCount: groups.length,
      completedAt: new Date().toISOString(),
    };
  }

  const previous = await findCompletedReceipt(deps.baseDir, fingerprint);
  if (previous) {
    const skipped: L1ReplayReceipt = {
      ...baseReceipt,
      status: "skipped",
      groupCount: previous.groupCount,
      successfulGroups: previous.successfulGroups,
      extractedCount: previous.extractedCount,
      storedCount: previous.storedCount,
      reusedReceiptId: previous.replayId,
      completedAt: new Date().toISOString(),
    };
    await appendReceipt(deps.baseDir, skipped);
    deps.logger.info(
      `${TAG} Exact replay already completed; skipped session=${normalized.sessionKey} ` +
      `receipt=${previous.replayId}`,
    );
    return skipped;
  }

  const groups = groupRows(rows);
  const receipt: L1ReplayReceipt = {
    ...baseReceipt,
    status: "completed",
    groupCount: groups.length,
    completedAt: startedAt,
  };

  try {
    for (const group of groups) {
      const result = await extractL1Memories({
        messages: group.messages,
        sessionKey: normalized.sessionKey,
        sessionId: group.sessionId,
        baseDir: deps.baseDir,
        config: deps.config,
        options: {
          enableDedup: true,
          maxMemoriesPerSession: deps.cfg.extraction.maxMemoriesPerSession,
          model: deps.cfg.extraction.model,
          vectorStore: deps.vectorStore,
          embeddingService: deps.embeddingService,
          conflictRecallTopK: deps.cfg.embedding.conflictRecallTopK,
          embeddingTimeoutMs: deps.cfg.embedding.captureTimeoutMs ?? deps.cfg.embedding.timeoutMs,
          llmRunner: deps.llmRunner,
        },
        logger: deps.logger,
        instanceId: deps.instanceId,
      });
      if (!result.success) {
        throw new Error(`L1 extraction failed for sessionId=${group.sessionId || "(empty)"}`);
      }
      receipt.successfulGroups++;
      receipt.extractedCount += result.extractedCount;
      receipt.storedCount += result.storedCount;
    }

    const checkpointAfter = await checkpoint.read();
    receipt.checkpointCursorAfter =
      checkpoint.getRunnerState(checkpointAfter, normalized.sessionKey).last_l1_cursor;
    receipt.completedAt = new Date().toISOString();
    await appendReceipt(deps.baseDir, receipt);
    deps.logger.info(
      `${TAG} Replay completed session=${normalized.sessionKey}: ` +
      `attempted=${receipt.attemptedCount}, extracted=${receipt.extractedCount}, stored=${receipt.storedCount}`,
    );
    return receipt;
  } catch (err) {
    const checkpointAfter = await checkpoint.read();
    receipt.status = "failed";
    receipt.checkpointCursorAfter =
      checkpoint.getRunnerState(checkpointAfter, normalized.sessionKey).last_l1_cursor;
    receipt.error = err instanceof Error ? err.message : String(err);
    receipt.completedAt = new Date().toISOString();
    await appendReceipt(deps.baseDir, receipt);
    throw new L1ReplayExecutionError(receipt.error, receipt);
  }
}

function normalizeRequest(request: L1ReplayRequest): Required<Pick<L1ReplayRequest, "sessionKey" | "limit" | "dryRun">> &
  Pick<L1ReplayRequest, "fromRecordedAtMs" | "toRecordedAtMs"> {
  const sessionKey = request.sessionKey?.trim();
  if (!sessionKey) {
    throw new L1ReplayValidationError("sessionKey is required");
  }
  for (const [name, value] of [
    ["fromRecordedAtMs", request.fromRecordedAtMs],
    ["toRecordedAtMs", request.toRecordedAtMs],
  ] as const) {
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      throw new L1ReplayValidationError(`${name} must be a non-negative epoch millisecond value`);
    }
  }
  if (
    request.fromRecordedAtMs != null &&
    request.toRecordedAtMs != null &&
    request.fromRecordedAtMs > request.toRecordedAtMs
  ) {
    throw new L1ReplayValidationError("fromRecordedAtMs must be <= toRecordedAtMs");
  }

  const limit = request.limit ?? DEFAULT_REPLAY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPLAY_LIMIT) {
    throw new L1ReplayValidationError(`limit must be an integer between 1 and ${MAX_REPLAY_LIMIT}`);
  }

  return {
    sessionKey,
    fromRecordedAtMs: request.fromRecordedAtMs,
    toRecordedAtMs: request.toRecordedAtMs,
    limit,
    dryRun: request.dryRun ?? false,
  };
}

async function readReplayRows(
  request: ReturnType<typeof normalizeRequest>,
  deps: L1ReplayDependencies,
): Promise<L0QueryRow[]> {
  if (deps.vectorStore && !deps.vectorStore.isDegraded()) {
    return await deps.vectorStore.queryL0ForReplay({
      sessionKey: request.sessionKey,
      fromRecordedAtMs: request.fromRecordedAtMs,
      toRecordedAtMs: request.toRecordedAtMs,
      limit: request.limit,
    });
  }

  const groups = await readConversationMessagesGroupedBySessionId(
    request.sessionKey,
    deps.baseDir,
    undefined,
    deps.logger,
  );
  const rows: L0QueryRow[] = [];
  for (const group of groups) {
    for (const message of group.messages) {
      if (request.fromRecordedAtMs != null && message.recordedAtMs < request.fromRecordedAtMs) continue;
      if (request.toRecordedAtMs != null && message.recordedAtMs > request.toRecordedAtMs) continue;
      rows.push({
        record_id: message.id,
        session_key: request.sessionKey,
        session_id: group.sessionId,
        role: message.role,
        message_text: message.content,
        recorded_at: new Date(message.recordedAtMs).toISOString(),
        timestamp: message.timestamp,
      });
    }
  }
  rows.sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
  return rows.slice(0, request.limit);
}

function groupRows(rows: L0QueryRow[]): Array<{
  sessionId: string;
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; timestamp: number }>;
}> {
  const groups = new Map<string, Array<{ id: string; role: "user" | "assistant"; content: string; timestamp: number }>>();
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const messages = groups.get(row.session_id) ?? [];
    messages.push({
      id: row.record_id,
      role: row.role,
      content: row.message_text,
      timestamp: row.timestamp,
    });
    groups.set(row.session_id, messages);
  }
  return [...groups.entries()].map(([sessionId, messages]) => ({ sessionId, messages }));
}

function replayFingerprint(request: ReturnType<typeof normalizeRequest>, recordIds: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({
      sessionKey: request.sessionKey,
      fromRecordedAtMs: request.fromRecordedAtMs ?? null,
      toRecordedAtMs: request.toRecordedAtMs ?? null,
      recordIds,
    }))
    .digest("hex");
}

async function findCompletedReceipt(baseDir: string, fingerprint: string): Promise<L1ReplayReceipt | undefined> {
  try {
    const raw = await fs.readFile(path.join(baseDir, L1_REPLAY_RECEIPT_PATH), "utf-8");
    for (const line of raw.trim().split("\n").reverse()) {
      if (!line.trim()) continue;
      const receipt = JSON.parse(line) as L1ReplayReceipt;
      if (receipt.fingerprint === fingerprint && receipt.status === "completed") {
        return receipt;
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  return undefined;
}

async function appendReceipt(baseDir: string, receipt: L1ReplayReceipt): Promise<void> {
  const receiptPath = path.join(baseDir, L1_REPLAY_RECEIPT_PATH);
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  await fs.appendFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf-8");
}
