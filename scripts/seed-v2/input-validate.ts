/**
 * Input loading, validation, normalization, and timestamp handling for seed-v2.
 *
 * ⚠️ 这份文件是从 `src/core/seed/input.ts` 拷来的精简版（去掉了 v1 CLI 专属的
 * `loadAndValidateInput`，因为它依赖 `SeedCommandOptions` 类型且会做交互式
 * timestamp 确认 —— seed-v2 是 HTTP 工具，不交互）。
 *
 * 老 v1 seed (`src/cli/commands/seed.ts` + `/seed` v1 endpoint) 计划废弃后，
 * 本文件成为唯一真理之源。在那之前，如果在 `src/core/seed/input.ts` 改了
 * `validateAndNormalizeRaw` / `fillTimestamps` / `SeedValidationError`，请
 * 同步到这里。
 *
 * 6 层校验 (file → top-level → session → round → message → timestamp consistency)
 * 中的 file 层在 seed-v2 自己读 fixture 时做（`loadFixtureFile`），不在本文件里。
 */

import crypto from "node:crypto";
import type {
  RawSession,
  FormatA,
  ValidationError,
  NormalizedInput,
  NormalizedSession,
  NormalizedRound,
  NormalizedMessage,
} from "./input-types.js";

// ============================
// Public API
// ============================

/**
 * Validate and normalize seed input from an already-parsed JSON object.
 *
 * Throws `SeedValidationError` on validation failures.
 *
 * Timestamp policy:
 * - All messages have timestamp → `hasTimestamps=true`, normalized as-is
 * - All messages missing → if `autoFillTimestamps` (default true), fill with
 *   globally-monotonic Date.now() + 100ms increments; else leave at 0
 * - Mixed (some have, some missing) → throw error
 */
export function validateAndNormalizeRaw(
  raw: unknown,
  opts?: { sessionKey?: string; strictRoundRole?: boolean; autoFillTimestamps?: boolean },
): NormalizedInput {
  const strictRoundRole = opts?.strictRoundRole ?? false;
  const autoFillTimestamps = opts?.autoFillTimestamps ?? true;

  // Layer 2: Top-level — detect Format A vs B
  const sessions = extractSessions(raw);

  // Layers 3-5: session / round / message validation
  const errors: ValidationError[] = [];
  validateSessions(sessions, strictRoundRole, errors);

  if (errors.length > 0) {
    throw new SeedValidationError(errors);
  }

  // Layer 6: Timestamp consistency (all-have / all-missing / mixed → error)
  const tsResult = checkTimestampConsistency(sessions);
  if (tsResult.status === "mixed") {
    throw new SeedValidationError([{
      stage: "timestamp_consistency",
      message:
        "Timestamp consistency check failed: some messages have timestamps while others do not. " +
        "All messages must either have timestamps or none must have timestamps.",
    }]);
  }

  // Normalize
  const normalized = normalizeSessions(sessions, opts?.sessionKey);

  const input: NormalizedInput = {
    sessions: normalized.sessions,
    totalRounds: normalized.totalRounds,
    totalMessages: normalized.totalMessages,
    hasTimestamps: tsResult.status === "all_present",
  };

  // Auto-fill timestamps when none present (HTTP tool, no interactive prompt)
  if (tsResult.status === "all_missing" && autoFillTimestamps) {
    fillTimestamps(input);
  }

  return input;
}

/**
 * Fill timestamps for all messages when the input has no timestamps.
 *
 * Uses a single monotonically increasing counter across ALL sessions to
 * guarantee global timestamp ordering — critical when multiple sessions
 * share the same sessionKey, since L0 capture cursor is advanced per-session
 * and would filter out later sessions whose timestamps fall below the cursor
 * if ordering were not globally monotonic.
 */
export function fillTimestamps(input: NormalizedInput): void {
  let currentTs = Date.now();
  for (const session of input.sessions) {
    for (const round of session.rounds) {
      for (let i = 0; i < round.messages.length; i++) {
        round.messages[i]!.timestamp = currentTs;
        currentTs += 100; // 100ms gap per message — matches v1 fillTimestamps
      }
    }
  }
  input.hasTimestamps = true;
}

// ============================
// Validation error class
// ============================

export class SeedValidationError extends Error {
  public readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    const summary = errors.map((e) => formatValidationError(e)).join("\n");
    super(`Seed input validation failed (${errors.length} error(s)):\n${summary}`);
    this.name = "SeedValidationError";
    this.errors = errors;
  }
}

function formatValidationError(e: ValidationError): string {
  const parts: string[] = [`  [${e.stage}]`];
  if (e.sourceIndex != null) parts.push(`session[${e.sourceIndex}]`);
  if (e.sessionKey) parts.push(`key="${e.sessionKey}"`);
  if (e.roundIndex != null) parts.push(`round[${e.roundIndex}]`);
  if (e.messageIndex != null) parts.push(`msg[${e.messageIndex}]`);
  parts.push(e.message);
  return parts.join(" ");
}

// ============================
// Layer 2: Top-level format detection
// ============================

function extractSessions(raw: unknown): RawSession[] {
  // Format A: { sessions: [...] }
  if (
    raw != null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "sessions" in raw
  ) {
    const obj = raw as FormatA;
    if (!Array.isArray(obj.sessions)) {
      throw new SeedValidationError([{
        stage: "top_level",
        message: 'Format A detected but "sessions" is not an array.',
      }]);
    }
    return obj.sessions;
  }

  // Format B: [...]
  if (Array.isArray(raw)) {
    return raw as RawSession[];
  }

  throw new SeedValidationError([{
    stage: "top_level",
    message:
      "Unrecognized input format. Expected either:\n" +
      '  Format A: { "sessions": [...] }\n' +
      "  Format B: [ { sessionKey, conversations }, ... ]",
  }]);
}

// ============================
// Layers 3-5: session / round / message validation
// ============================

function validateSessions(
  sessions: RawSession[],
  strictRoundRole: boolean,
  errors: ValidationError[],
): void {
  if (sessions.length === 0) {
    errors.push({
      stage: "session",
      message: "No sessions found in input.",
    });
    return;
  }

  for (let si = 0; si < sessions.length; si++) {
    const session = sessions[si]!;

    // Layer 3: session validation
    if (!session.sessionKey || typeof session.sessionKey !== "string" || session.sessionKey.trim() === "") {
      errors.push({
        stage: "session",
        sourceIndex: si,
        message: '"sessionKey" is required and must be a non-empty string.',
      });
    }

    if (!Array.isArray(session.conversations)) {
      errors.push({
        stage: "session",
        sourceIndex: si,
        sessionKey: session.sessionKey,
        message: '"conversations" must be a two-dimensional array (array of rounds).',
      });
      continue;
    }

    for (let ri = 0; ri < session.conversations.length; ri++) {
      const round = session.conversations[ri];

      // Layer 4: round validation
      if (!Array.isArray(round)) {
        errors.push({
          stage: "round",
          sourceIndex: si,
          sessionKey: session.sessionKey,
          roundIndex: ri,
          message: "Round must be an array of messages.",
        });
        continue;
      }

      if (round.length === 0) {
        errors.push({
          stage: "round",
          sourceIndex: si,
          sessionKey: session.sessionKey,
          roundIndex: ri,
          message: "Round must be a non-empty array.",
        });
        continue;
      }

      // Strict round-role: each round must have at least one user and one assistant
      if (strictRoundRole) {
        const roles = new Set(round.map((m) => m.role));
        if (!roles.has("user")) {
          errors.push({
            stage: "round",
            sourceIndex: si,
            sessionKey: session.sessionKey,
            roundIndex: ri,
            message: '--strict-round-role: round must contain at least one "user" message.',
          });
        }
        if (!roles.has("assistant")) {
          errors.push({
            stage: "round",
            sourceIndex: si,
            sessionKey: session.sessionKey,
            roundIndex: ri,
            message: '--strict-round-role: round must contain at least one "assistant" message.',
          });
        }
      }

      // Layer 5: message validation
      for (let mi = 0; mi < round.length; mi++) {
        const msg = round[mi]!;

        if (!msg.role || typeof msg.role !== "string") {
          errors.push({
            stage: "message",
            sourceIndex: si,
            sessionKey: session.sessionKey,
            roundIndex: ri,
            messageIndex: mi,
            message: '"role" is required and must be a non-empty string.',
          });
        }

        if (!msg.content || typeof msg.content !== "string" || msg.content.trim() === "") {
          errors.push({
            stage: "message",
            sourceIndex: si,
            sessionKey: session.sessionKey,
            roundIndex: ri,
            messageIndex: mi,
            message: '"content" is required and must be a non-empty string.',
          });
        }

        if (msg.timestamp !== undefined) {
          if (typeof msg.timestamp === "number") {
            if (!Number.isInteger(msg.timestamp)) {
              errors.push({
                stage: "message",
                sourceIndex: si,
                sessionKey: session.sessionKey,
                roundIndex: ri,
                messageIndex: mi,
                message: '"timestamp" must be an integer (epoch milliseconds). Negative values allowed for pre-1970 dates.',
              });
            }
          } else if (typeof msg.timestamp === "string") {
            if (Number.isNaN(new Date(msg.timestamp).getTime())) {
              errors.push({
                stage: "message",
                sourceIndex: si,
                sessionKey: session.sessionKey,
                roundIndex: ri,
                messageIndex: mi,
                message: `"timestamp" string is not a valid ISO 8601 date: "${msg.timestamp}".`,
              });
            }
          } else {
            errors.push({
              stage: "message",
              sourceIndex: si,
              sessionKey: session.sessionKey,
              roundIndex: ri,
              messageIndex: mi,
              message: '"timestamp" must be a number (epoch ms) or an ISO 8601 string.',
            });
          }
        }
      }
    }
  }
}

// ============================
// Layer 6: Timestamp consistency
// ============================

interface TimestampCheckResult {
  status: "all_present" | "all_missing" | "mixed";
}

function checkTimestampConsistency(sessions: RawSession[]): TimestampCheckResult {
  let hasTs = false;
  let missingTs = false;

  for (const session of sessions) {
    if (!Array.isArray(session.conversations)) continue;
    for (const round of session.conversations) {
      if (!Array.isArray(round)) continue;
      for (const msg of round) {
        if (msg.timestamp !== undefined && msg.timestamp !== null) {
          hasTs = true;
        } else {
          missingTs = true;
        }
        if (hasTs && missingTs) {
          return { status: "mixed" };
        }
      }
    }
  }

  if (hasTs && !missingTs) return { status: "all_present" };
  if (!hasTs && missingTs) return { status: "all_missing" };
  // No messages at all — treat as all_missing (will be caught by session validation)
  return { status: "all_missing" };
}

// ============================
// Normalization
// ============================

function normalizeSessions(
  sessions: RawSession[],
  fallbackSessionKey?: string,
): { sessions: NormalizedSession[]; totalRounds: number; totalMessages: number } {
  const normalized: NormalizedSession[] = [];
  let totalRounds = 0;
  let totalMessages = 0;

  for (let si = 0; si < sessions.length; si++) {
    const raw = sessions[si]!;

    const sessionKey = raw.sessionKey || fallbackSessionKey || "seed-user";
    const sessionId = raw.sessionId || crypto.randomUUID();

    const rounds: NormalizedRound[] = [];
    for (const rawRound of raw.conversations) {
      if (!Array.isArray(rawRound)) continue;

      const messages: NormalizedMessage[] = rawRound.map((msg) => ({
        role: msg.role,
        content: msg.content,
        // Normalize timestamp: ISO string → epoch ms; number → pass-through; missing → 0 (filled later)
        timestamp: msg.timestamp == null
          ? 0
          : typeof msg.timestamp === "string"
            ? new Date(msg.timestamp).getTime()
            : msg.timestamp,
      }));

      rounds.push({ messages });
      totalMessages += messages.length;
    }

    totalRounds += rounds.length;
    normalized.push({
      sessionKey,
      sessionId,
      rounds,
      sourceIndex: si,
    });
  }

  return { sessions: normalized, totalRounds, totalMessages };
}
