/**
 * TencentDB Agent Memory SDK error types.
 */

export class ParamError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ParamError";
  }
}

export class TDAMError extends Error {
  readonly code: number;
  readonly requestId: string;
  /**
   * Optional server-provided error details.
   *
   * Some endpoints put diagnostic fields into `data` even when `code !== 0`
   * (e.g. `/v3/skill/update` returns `{ current_version }` on 40901
   * SKILL_VERSION_STALE, `/v3/skill/files/read` returns `{ latest_version }`
   * on 41002 SKILL_VERSION_EXPIRED). This preserves them for callers doing
   * conflict recovery.
   */
  readonly details?: Record<string, unknown>;

  constructor(code: number, message: string, requestId = "", details?: Record<string, unknown>) {
    super(`[${code}] ${message} (request_id=${requestId})`);
    this.name = "TDAMError";
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}
