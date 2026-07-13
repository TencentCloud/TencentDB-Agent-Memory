import type { CompletedTurn } from "../core/types.js";
import { validateAndNormalizeRaw, SeedValidationError } from "../core/seed/input.js";
import type { NormalizedInput } from "../core/seed/types.js";
import type { CaptureBatchRequest, CaptureRequest } from "./types.js";

export const MAX_CAPTURE_BATCH_SIZE = 100;
export const HISTORICAL_CAPTURE_STARTED_AT = 0;
const TIMESTAMP_STEP_MS = 100;

export class CaptureBatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureBatchValidationError";
  }
}

export interface NormalizedCaptureBatchItem {
  index: number;
  capture: CaptureRequest;
  startedAt: number;
  sourceSessionIndex?: number;
  sourceRoundIndex?: number;
}

export interface NormalizedCaptureBatch {
  captures: NormalizedCaptureBatchItem[];
  continueOnError: boolean;
  source: "captures" | "seed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(
  value: Record<string, unknown>,
  key: keyof CaptureRequest,
  label: string,
): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new CaptureBatchValidationError(`${label}.${key} must be a non-empty string`);
  }
  return raw;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: keyof CaptureRequest,
): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

function parseTimestamp(value: unknown, label: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new CaptureBatchValidationError(`${label} must be an integer epoch millisecond timestamp`);
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    if (Number.isNaN(parsed)) {
      throw new CaptureBatchValidationError(`${label} must be an epoch millisecond number or valid ISO 8601 string`);
    }
    return parsed;
  }
  throw new CaptureBatchValidationError(`${label} must be an epoch millisecond number or valid ISO 8601 string`);
}

function makeTimestampAllocator(startMs: number): () => number {
  let next = startMs;
  return () => {
    const value = next;
    next += TIMESTAMP_STEP_MS;
    return value;
  };
}

function normalizeMessages(
  rawMessages: unknown[] | undefined,
  userContent: string,
  assistantContent: string,
  nextTimestamp: (() => number) | undefined,
  label: string,
): unknown[] {
  if (!rawMessages) {
    if (!nextTimestamp) {
      return [
        { role: "user", content: userContent },
        { role: "assistant", content: assistantContent },
      ];
    }
    return [
      { role: "user", content: userContent, timestamp: nextTimestamp() },
      { role: "assistant", content: assistantContent, timestamp: nextTimestamp() },
    ];
  }

  return rawMessages.map((message, index) => {
    if (!isRecord(message)) return message;
    const parsed = parseTimestamp(message.timestamp, `${label}.messages[${index}].timestamp`);
    if (parsed !== undefined) return { ...message, timestamp: parsed };
    if (nextTimestamp) return { ...message, timestamp: nextTimestamp() };
    return message;
  });
}

export function normalizeCapturePayload(
  raw: unknown,
  label = "capture",
  nextTimestamp?: () => number,
): CaptureRequest {
  if (!isRecord(raw)) {
    throw new CaptureBatchValidationError(`${label} must be an object`);
  }

  const rawMessages = raw.messages;
  if (rawMessages !== undefined && !Array.isArray(rawMessages)) {
    throw new CaptureBatchValidationError(`${label}.messages must be an array when provided`);
  }

  const userContent = readRequiredString(raw, "user_content", label);
  const assistantContent = readRequiredString(raw, "assistant_content", label);
  const sessionKey = readRequiredString(raw, "session_key", label);

  return {
    user_content: userContent,
    assistant_content: assistantContent,
    session_key: sessionKey,
    session_id: readOptionalString(raw, "session_id"),
    user_id: readOptionalString(raw, "user_id"),
    messages: normalizeMessages(rawMessages, userContent, assistantContent, nextTimestamp, label),
  };
}

function normalizeSeedInput(body: CaptureBatchRequest): NormalizedInput {
  try {
    const input = validateAndNormalizeRaw(body.data, {
      sessionKey: body.session_key,
      strictRoundRole: body.strict_round_role,
      autoFillTimestamps: body.auto_fill_timestamps ?? true,
    });
    if (!input.hasTimestamps) {
      throw new CaptureBatchValidationError(
        "seed-format batch import requires timestamps unless auto_fill_timestamps is true",
      );
    }
    return input;
  } catch (err) {
    if (err instanceof CaptureBatchValidationError) throw err;
    if (err instanceof SeedValidationError) {
      throw new CaptureBatchValidationError(err.message);
    }
    throw err;
  }
}

function capturesFromSeedInput(input: NormalizedInput): NormalizedCaptureBatchItem[] {
  const captures: NormalizedCaptureBatchItem[] = [];

  for (const session of input.sessions) {
    for (let roundIndex = 0; roundIndex < session.rounds.length; roundIndex++) {
      const round = session.rounds[roundIndex]!;
      const userMessage = round.messages.find((message) => message.role === "user");
      const assistantMessage = [...round.messages].reverse().find((message) => message.role === "assistant");

      if (!userMessage || !assistantMessage) {
        throw new CaptureBatchValidationError(
          `data.sessions[${session.sourceIndex}].conversations[${roundIndex}] must contain at least one user and one assistant message`,
        );
      }

      captures.push({
        index: captures.length,
        capture: {
          user_content: userMessage.content,
          assistant_content: assistantMessage.content,
          session_key: session.sessionKey,
          session_id: session.sessionId,
          messages: round.messages.map((message) => ({
            role: message.role,
            content: message.content,
            timestamp: message.timestamp,
          })),
        },
        startedAt: HISTORICAL_CAPTURE_STARTED_AT,
        sourceSessionIndex: session.sourceIndex,
        sourceRoundIndex: roundIndex,
      });
    }
  }

  return captures;
}

function enforceBatchLimit(captures: NormalizedCaptureBatchItem[]): void {
  if (captures.length === 0) {
    throw new CaptureBatchValidationError("captures must be a non-empty array");
  }
  if (captures.length > MAX_CAPTURE_BATCH_SIZE) {
    throw new CaptureBatchValidationError(
      `captures must contain at most ${MAX_CAPTURE_BATCH_SIZE} items`,
    );
  }
}

export function normalizeCaptureBatchRequest(
  body: CaptureBatchRequest,
  nowMs = Date.now(),
): NormalizedCaptureBatch {
  if (!isRecord(body)) {
    throw new CaptureBatchValidationError("request body must be an object");
  }

  const hasSeedData = body.data !== undefined;
  const rawCaptures = Array.isArray(body.captures)
    ? body.captures
    : Array.isArray(body.items)
      ? body.items
      : undefined;

  if (hasSeedData && rawCaptures) {
    throw new CaptureBatchValidationError("provide either data or captures, not both");
  }

  const continueOnError = body.continue_on_error === true;

  if (hasSeedData) {
    const captures = capturesFromSeedInput(normalizeSeedInput(body));
    enforceBatchLimit(captures);
    return { captures, continueOnError, source: "seed" };
  }

  if (!rawCaptures) {
    throw new CaptureBatchValidationError("captures must be a non-empty array");
  }

  const nextTimestamp = makeTimestampAllocator(nowMs);
  const captures = rawCaptures.map((capture, index) => ({
    index,
    capture: normalizeCapturePayload(capture, `captures[${index}]`, nextTimestamp),
    startedAt: HISTORICAL_CAPTURE_STARTED_AT,
  }));
  enforceBatchLimit(captures);
  return { captures, continueOnError, source: "captures" };
}

export function buildCaptureTurn(
  capture: CaptureRequest,
  opts?: { startedAt?: number },
): CompletedTurn {
  return {
    userText: capture.user_content,
    assistantText: capture.assistant_content,
    messages: capture.messages ?? [
      { role: "user", content: capture.user_content },
      { role: "assistant", content: capture.assistant_content },
    ],
    sessionKey: capture.session_key,
    sessionId: capture.session_id,
    startedAt: opts?.startedAt,
  };
}
