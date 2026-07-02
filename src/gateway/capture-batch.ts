import type { CaptureBatchRequest, CaptureRequest } from "./types.js";

export const MAX_CAPTURE_BATCH_SIZE = 100;

export class CaptureBatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureBatchValidationError";
  }
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
  return typeof raw === "string" ? raw : undefined;
}

export function normalizeCapturePayload(raw: unknown, label = "capture"): CaptureRequest {
  if (!isRecord(raw)) {
    throw new CaptureBatchValidationError(`${label} must be an object`);
  }

  const messages = raw.messages;
  if (messages !== undefined && !Array.isArray(messages)) {
    throw new CaptureBatchValidationError(`${label}.messages must be an array when provided`);
  }

  return {
    user_content: readRequiredString(raw, "user_content", label),
    assistant_content: readRequiredString(raw, "assistant_content", label),
    session_key: readRequiredString(raw, "session_key", label),
    session_id: readOptionalString(raw, "session_id"),
    user_id: readOptionalString(raw, "user_id"),
    messages,
  };
}

export function normalizeCaptureBatchRequest(body: CaptureBatchRequest): {
  captures: CaptureRequest[];
  continueOnError: boolean;
} {
  if (!isRecord(body)) {
    throw new CaptureBatchValidationError("request body must be an object");
  }

  const rawCaptures = Array.isArray(body.captures)
    ? body.captures
    : Array.isArray(body.items)
      ? body.items
      : undefined;

  if (!rawCaptures || rawCaptures.length === 0) {
    throw new CaptureBatchValidationError("captures must be a non-empty array");
  }
  if (rawCaptures.length > MAX_CAPTURE_BATCH_SIZE) {
    throw new CaptureBatchValidationError(
      `captures must contain at most ${MAX_CAPTURE_BATCH_SIZE} items`,
    );
  }

  return {
    captures: rawCaptures.map((capture, index) =>
      normalizeCapturePayload(capture, `captures[${index}]`),
    ),
    continueOnError: body.continue_on_error === true,
  };
}
