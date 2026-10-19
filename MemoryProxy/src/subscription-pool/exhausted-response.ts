/**
 * The 429 the proxy returns when no pool account can serve a request and the client has no
 * login of its own to fall back to. The body has the shape of a Codex `usage_limit_reached`
 * error, so Codex shows the reset time the same way as for a plain account limit.
 */

/** Seconds to wait when no account reports a reset time. Same as the 15 minute default hold in Core. */
export const UNKNOWN_RESET_RETRY_AFTER_SEC = 900;

/** Seconds to wait when the account list could not be read from Core. */
export const UNAVAILABLE_RETRY_AFTER_SEC = 30;

/**
 * The 503 the proxy returns when Core cannot list the pool accounts and no earlier list exists.
 * It is not a quota answer, so the client does not wait for a reset that will not come.
 */
export function buildPoolUnavailableResponse(): Response {
  return new Response(JSON.stringify({
    error: { type: "server_error", message: "The subscription pool is unavailable. Try again shortly." },
  }), {
    status: 503,
    headers: {
      "content-type": "application/json",
      "x-tdai-pool-status": "unavailable",
      "retry-after": String(UNAVAILABLE_RETRY_AFTER_SEC),
    },
  });
}

export function buildPoolExhaustedResponse(earliestResetMs: number | null, now: number): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-tdai-pool-status": "exhausted",
  };
  const error: Record<string, unknown> = {
    type: "usage_limit_reached",
    message: "All subscription accounts of this pool have reached their usage limit.",
  };

  if (earliestResetMs !== null) {
    const resetsAtSec = Math.ceil(earliestResetMs / 1000);
    headers["retry-after"] = String(Math.max(1, Math.ceil((earliestResetMs - now) / 1000)));
    headers["x-tdai-pool-earliest-reset"] = String(resetsAtSec);
    error.resets_at = resetsAtSec;
  } else {
    headers["retry-after"] = String(UNKNOWN_RESET_RETRY_AFTER_SEC);
  }
  return new Response(JSON.stringify({ error }), { status: 429, headers });
}
