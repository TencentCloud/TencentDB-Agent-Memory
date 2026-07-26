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

/**
 * A session-dedupe decision that has not been recorded in session state yet.
 *
 * Callers that may subsequently drop or transform recall lines (for example,
 * when applying a character budget) should use
 * `prepareSessionRecallDedupeDetailed`, then call
 * `commitSessionRecallDedupe` with only the full lines that were actually
 * injected.  The legacy `applySessionRecallDedupe*` helpers still perform
 * both phases synchronously.
 */
export interface RecallDedupePreparation extends RecallDedupeResult {
  /** Commit this decision. Calling it more than once is safe. */
  readonly commit: (injectedFullLines?: readonly string[]) => void;
}

interface SessionDigestState {
  turn: number;
  digests: Map<string, number>;
}

const sessionRecallDigests = new Map<string, SessionDigestState>();
const pendingRecallDedupe = new WeakMap<RecallDedupePreparation, PendingRecallDedupe>();

interface PendingRecallCandidate {
  line: string;
  digest: string;
}

interface PendingRecallDedupe {
  active: boolean;
  sessionKey: string;
  recall: RecallDedupeConfig;
  logger?: LoggerLike;
  candidates: PendingRecallCandidate[];
  committed: boolean;
}

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
  const preparation = prepareSessionRecallDedupeDetailed(lines, sessionKey, recall, logger);
  // Preserve the historical synchronous API: all lines selected by the
  // dedupe decision are considered injected immediately.
  commitSessionRecallDedupe(preparation);
  return {
    fullLines: preparation.fullLines,
    reminderLines: preparation.reminderLines,
    skippedCount: preparation.skippedCount,
  };
}

/**
 * Decide which recall lines are new for a session without mutating the
 * session's digest state.
 *
 * The returned preparation can safely be discarded when the surrounding
 * operation fails or when a later budget/filter removes all of its full
 * lines.  Only `commitSessionRecallDedupe` records digests.
 */
export function prepareSessionRecallDedupeDetailed(
  lines: string[],
  sessionKey: string,
  recall: RecallDedupeConfig,
  logger?: LoggerLike,
): RecallDedupePreparation {
  const mode = resolveDedupeMode(recall);
  if (mode === "off" || lines.length === 0) {
    return createRecallDedupePreparation(
      { fullLines: lines, reminderLines: [], skippedCount: 0 },
      {
        active: false,
        sessionKey,
        recall,
        logger,
        candidates: [],
        committed: false,
      },
    );
  }

  const ttlTurns = normalizePositiveInteger(recall.dedupeInjectedTtlTurns);
  // Reading an absent state must not create one: a preparation may be
  // abandoned (e.g. on timeout) and should then have no session side effect.
  const state = sessionRecallDigests.get(sessionKey);
  const currentTurn = state?.turn ?? 0;
  const nextTurn = currentTurn + 1;
  const knownDigests = state?.digests;

  const kept: string[] = [];
  const reminders: string[] = [];
  const candidates: PendingRecallCandidate[] = [];
  const preparedDigests = new Set<string>();
  let skipped = 0;
  let reminderChars = 0;
  const maxReminderChars = normalizePositiveInteger(recall.maxReminderChars);

  for (const line of lines) {
    const digest = digestRecallLine(line);
    const lastInjectedTurn = knownDigests?.get(digest);
    const isDuplicate = lastInjectedTurn != null
      && (!ttlTurns || nextTurn - lastInjectedTurn <= ttlTurns);

    if (isDuplicate || preparedDigests.has(digest)) {
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
    candidates.push({ line, digest });
    preparedDigests.add(digest);
  }

  if (skipped > 0) {
    logger?.debug?.(
      `${TAG} Session recall dedupe applied: session=${sessionKey}, input=${lines.length}, ` +
      `output=${kept.length}, reminders=${reminders.length}, skipped=${skipped}, ` +
      `mode=${mode}, ttlTurns=${recall.dedupeInjectedTtlTurns}`,
    );
  }

  return createRecallDedupePreparation(
    { fullLines: kept, reminderLines: reminders, skippedCount: skipped - reminders.length },
    {
      active: true,
      sessionKey,
      recall,
      logger,
      candidates,
      committed: false,
    },
  );
}

/**
 * Record only the full recall lines that were actually injected.
 *
 * `injectedFullLines` may contain the prepared source lines or their bounded
 * forms produced by `applyRecallBudget`; bounded lines are matched in source
 * order so their original digest is committed.  Unknown lines are ignored.
 * The commit is idempotent, which makes it safe for cleanup/finally paths.
 */
export function commitSessionRecallDedupe(
  preparation: RecallDedupePreparation,
  injectedFullLines: readonly string[] = preparation.fullLines,
): void {
  const pending = pendingRecallDedupe.get(preparation);
  if (!pending || pending.committed) return;
  pending.committed = true;

  if (!pending.active) return;

  const state = getSessionDigestState(pending.sessionKey);
  state.turn += 1;

  const selected = selectCommittedRecallCandidates(pending.candidates, injectedFullLines);
  for (const candidate of selected) {
    state.digests.set(candidate.digest, state.turn);
  }

  pruneSessionDigestState(state);
  pruneSessionDigestSessions();
}

function createRecallDedupePreparation(
  result: RecallDedupeResult,
  pending: PendingRecallDedupe,
): RecallDedupePreparation {
  const preparation = { ...result } as RecallDedupePreparation;
  Object.defineProperty(preparation, "commit", {
    configurable: false,
    enumerable: false,
    value: (injectedFullLines?: readonly string[]) => {
      commitSessionRecallDedupe(preparation, injectedFullLines);
    },
    writable: false,
  });
  pendingRecallDedupe.set(preparation, pending);
  return preparation;
}

function selectCommittedRecallCandidates(
  candidates: readonly PendingRecallCandidate[],
  injectedFullLines: readonly string[],
): PendingRecallCandidate[] {
  if (candidates.length === 0 || injectedFullLines.length === 0) return [];

  const selected: PendingRecallCandidate[] = [];
  const used = new Set<number>();
  let sourceCursor = 0;

  for (const injectedLine of injectedFullLines) {
    // Prefer an exact source-line match. This supports callers that filter a
    // prepared result (rather than merely applying the character budget).
    let matchIndex = -1;
    for (let i = sourceCursor; i < candidates.length; i++) {
      if (!used.has(i) && candidates[i].line === injectedLine) {
        matchIndex = i;
        break;
      }
    }

    // applyRecallBudget preserves order and may truncate a source line. When
    // no exact match exists, accept the next source line only if the injected
    // text is recognisably a bounded prefix of it. This lets us commit the
    // original digest without ever marking an unrelated line as injected.
    if (matchIndex < 0) {
      for (let i = sourceCursor; i < candidates.length; i++) {
        if (!used.has(i) && isBoundedRecallVariant(injectedLine, candidates[i].line)) {
          matchIndex = i;
          break;
        }
      }
    }

    if (matchIndex < 0) continue;
    used.add(matchIndex);
    sourceCursor = matchIndex + 1;
    selected.push(candidates[matchIndex]);
  }

  return selected;
}

function isBoundedRecallVariant(injectedLine: string, sourceLine: string): boolean {
  if (injectedLine === sourceLine || injectedLine.length >= sourceLine.length) return false;
  const suffixIndex = injectedLine.indexOf(RECALL_TRUNCATION_SUFFIX);
  if (suffixIndex >= 0) {
    const prefix = injectedLine.slice(0, suffixIndex).trimEnd();
    return prefix.length > 0 && sourceLine.startsWith(prefix);
  }

  // For very small budgets the truncation suffix itself cannot fit, so
  // applyRecallBudget emits a plain source prefix.
  return sourceLine.startsWith(injectedLine);
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
