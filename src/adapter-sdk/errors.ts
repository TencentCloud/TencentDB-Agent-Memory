/**
 * Adapter SDK — Error model.
 *
 * Every `MemoryClient` method rejects with a `MemoryClientError` so platform
 * adapters can branch on a stable `code` instead of parsing transport-specific
 * messages (HTTP status text vs. core exception strings).
 */

/** Machine-readable failure categories, stable across transports. */
export type MemoryClientErrorCode =
  /** Network / process-level failure: connection refused, timeout, 5xx, core threw. */
  | "transport"
  /** Authentication rejected (HTTP 401 from the gateway). */
  | "auth"
  /** The request was malformed or missing required fields (HTTP 400). */
  | "bad_request"
  /** The backing engine is not ready / not reachable in a way that may recover. */
  | "unavailable";

export class MemoryClientError extends Error {
  /** Stable machine-readable category. */
  readonly code: MemoryClientErrorCode;
  /** HTTP status when the failure came off the wire (undefined in-process). */
  readonly httpStatus?: number;

  constructor(
    code: MemoryClientErrorCode,
    message: string,
    opts?: { httpStatus?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "MemoryClientError";
    this.code = code;
    this.httpStatus = opts?.httpStatus;
  }
}

/** Map an HTTP status to the canonical error code. */
export function codeForHttpStatus(status: number): MemoryClientErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 400) return "bad_request";
  if (status === 503) return "unavailable";
  return "transport";
}
