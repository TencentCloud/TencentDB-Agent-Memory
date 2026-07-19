import { createHash } from "node:crypto";

type LoggerLike = {
  debug?: (message: string) => void;
};

export const RECALL_LINE_SEPARATOR = "\n";

const TAG = "[memory-tdai] [recall]";
const RECALL_TRUNCATION_SUFFIX = "…（已截断；可用 tdai_memory_search 或 tdai_conversation_search 查看详情）";
const MIN_TRUNCATED_RECALL_LINE_CHARS = 40;
const SESSION_DIGEST_MAX_SESSIONS = 1000;
const SESSION_DIGEST_MAX_ENTRIES = 500;

export interface RecallBudgetConfig {
  maxCharsPerMemory: number;
  maxTotalRecallChars: number;
}

export interface RecallDedupeConfig {
  dedupeInjected: boolean;
  dedupeMode?: "off" | "skip" | "reminder";
  dedupeInjectedTtlTurns: number;
  maxReminderChars?: number;
}

export interface RecallDedupeResult {
  fullLines: string[];
  reminderLines: string[];
  skippedCount: number;
}

interface SessionDigestState {
  turn: number;
  digests: Map<string, number>;
}

const sessionRecallDigests = new Map<string, SessionDigestState>();

export function applyRecallBudget(
  lines: string[],
  recall: RecallBudgetConfig,
  logger?: LoggerLike,
): string[] {
  const maxCharsPerMemory = normalizePositiveInteger(recall.maxCharsPerMemory);
  const maxTotalRecallChars = normalizePositiveInteger(recall.maxTotalRecallChars);

  if (!maxCharsPerMemory && !maxTotalRecallChars) {
    return lines;
  }

  const budgeted: string[] = [];
  let usedChars = 0;
  let truncatedCount = 0;
  let droppedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const perMemoryBounded = maxCharsPerMemory
      ? truncateRecallLine(line, maxCharsPerMemory)
      : line;
    let wasTruncated = perMemoryBounded !== line;

    if (!maxTotalRecallChars) {
      budgeted.push(perMemoryBounded);
      if (wasTruncated) truncatedCount++;
      continue;
    }

    const separatorChars = budgeted.length > 0 ? RECALL_LINE_SEPARATOR.length : 0;
    const remainingChars = maxTotalRecallChars - usedChars - separatorChars;
    if (remainingChars <= 0) {
      droppedCount += lines.length - i;
      break;
    }

    if (perMemoryBounded.length > remainingChars) {
      const canFit = remainingChars >= MIN_TRUNCATED_RECALL_LINE_CHARS;
      if (canFit) {
        const totalBounded = truncateRecallLine(perMemoryBounded, remainingChars);
        budgeted.push(totalBounded);
        usedChars += separatorChars + totalBounded.length;
        wasTruncated ||= totalBounded !== perMemoryBounded;
        if (wasTruncated) truncatedCount++;
      }
      droppedCount += lines.length - i - (canFit ? 1 : 0);
      break;
    }

    budgeted.push(perMemoryBounded);
    usedChars += separatorChars + perMemoryBounded.length;
    if (wasTruncated) truncatedCount++;
  }

  if (truncatedCount > 0 || droppedCount > 0) {
    logger?.debug?.(
      `${TAG} Recall budget applied: input=${lines.length}, output=${budgeted.length}, ` +
      `truncated=${truncatedCount}, dropped=${droppedCount}, ` +
      `maxCharsPerMemory=${recall.maxCharsPerMemory}, maxTotalRecallChars=${recall.maxTotalRecallChars}`,
    );
  }

  return budgeted;
}

export function applySessionRecallDedupe(
  lines: string[],
  sessionKey: string,
  recall: RecallDedupeConfig,
  logger?: LoggerLike,
): string[] {
  return applySessionRecallDedupeDetailed(lines, sessionKey, recall, logger).fullLines;
}

export function applySessionRecallDedupeDetailed(
  lines: string[],
  sessionKey: string,
  recall: RecallDedupeConfig,
  logger?: LoggerLike,
): RecallDedupeResult {
  const mode = resolveDedupeMode(recall);
  if (mode === "off" || lines.length === 0) {
    return { fullLines: lines, reminderLines: [], skippedCount: 0 };
  }

  const ttlTurns = normalizePositiveInteger(recall.dedupeInjectedTtlTurns);
  const state = getSessionDigestState(sessionKey);
  state.turn += 1;

  const kept: string[] = [];
  const reminders: string[] = [];
  let skipped = 0;
  let reminderChars = 0;
  const maxReminderChars = normalizePositiveInteger(recall.maxReminderChars);

  for (const line of lines) {
    const digest = digestRecallLine(line);
    const lastInjectedTurn = state.digests.get(digest);
    const isDuplicate = lastInjectedTurn != null
      && (!ttlTurns || state.turn - lastInjectedTurn <= ttlTurns);

    if (isDuplicate) {
      skipped++;
      if (mode === "reminder") {
        const reminder = toRecallReminderLine(line);
        const separatorChars = reminders.length > 0 ? RECALL_LINE_SEPARATOR.length : 0;
        if (!maxReminderChars || reminderChars + separatorChars + reminder.length <= maxReminderChars) {
          reminders.push(reminder);
          reminderChars += separatorChars + reminder.length;
        }
      }
      continue;
    }

    kept.push(line);
    state.digests.set(digest, state.turn);
  }

  pruneSessionDigestState(state);
  pruneSessionDigestSessions();

  if (skipped > 0) {
    logger?.debug?.(
      `${TAG} Session recall dedupe applied: session=${sessionKey}, input=${lines.length}, ` +
      `output=${kept.length}, reminders=${reminders.length}, skipped=${skipped}, ` +
      `mode=${mode}, ttlTurns=${recall.dedupeInjectedTtlTurns}`,
    );
  }

  return { fullLines: kept, reminderLines: reminders, skippedCount: skipped - reminders.length };
}

export function resetSessionRecallDedupeForTest(): void {
  sessionRecallDigests.clear();
}

export function digestRecallLine(line: string): string {
  const normalized = line
    .replace(/\s*\(活动时间:[^)]+\)\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

function resolveDedupeMode(recall: RecallDedupeConfig): "off" | "skip" | "reminder" {
  if (recall.dedupeMode) return recall.dedupeMode;
  return recall.dedupeInjected ? "skip" : "off";
}

function toRecallReminderLine(line: string): string {
  const normalized = line
    .replace(/\s*\(活动时间:[^)]+\)\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  const maxChars = 180;
  return truncatePlainText(normalized, maxChars);
}

function truncatePlainText(line: string, maxChars: number): string {
  const cps = Array.from(line);
  if (cps.length <= maxChars) return line;
  return `${cps.slice(0, Math.max(1, maxChars - 1)).join("").trimEnd()}…`;
}

function getSessionDigestState(sessionKey: string): SessionDigestState {
  let state = sessionRecallDigests.get(sessionKey);
  if (!state) {
    state = { turn: 0, digests: new Map() };
    sessionRecallDigests.set(sessionKey, state);
  }
  return state;
}

function pruneSessionDigestState(state: SessionDigestState): void {
  if (state.digests.size <= SESSION_DIGEST_MAX_ENTRIES) return;
  const sorted = [...state.digests.entries()].sort((a, b) => b[1] - a[1]);
  state.digests = new Map(sorted.slice(0, SESSION_DIGEST_MAX_ENTRIES));
}

function pruneSessionDigestSessions(): void {
  if (sessionRecallDigests.size <= SESSION_DIGEST_MAX_SESSIONS) return;
  const sorted = [...sessionRecallDigests.entries()].sort((a, b) => b[1].turn - a[1].turn);
  sessionRecallDigests.clear();
  for (const [key, value] of sorted.slice(0, SESSION_DIGEST_MAX_SESSIONS)) {
    sessionRecallDigests.set(key, value);
  }
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function truncateRecallLine(line: string, maxChars: number): string {
  const cps = Array.from(line);
  if (cps.length <= maxChars) return line;
  if (maxChars <= RECALL_TRUNCATION_SUFFIX.length) {
    return cps.slice(0, maxChars).join("");
  }
  return `${cps.slice(0, maxChars - RECALL_TRUNCATION_SUFFIX.length).join("").trimEnd()}${RECALL_TRUNCATION_SUFFIX}`;
}
