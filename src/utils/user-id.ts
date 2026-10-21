/**
 * User ID normalization and per-user routing decision.
 *
 * Shared by the gateway (`src/gateway/`) and available to any caller that
 * needs the same semantics. The provider side (Python) implements the
 * identical rules — keep both in sync:
 *
 *   normalize: `lowercase(asciiTrim(raw))` must then match `^[a-z0-9_-]{1,64}$`
 *   in full, otherwise the id is invalid (null). Lowercase only — characters
 *   are NEVER stripped (fail-closed): an id like `wendy.li` is rejected
 *   outright rather than silently mapped onto `wendyli`.
 *
 *   Trim is ASCII-only (space, \t \n \v \f \r) on BOTH sides — JS `trim()`
 *   and Python `strip()` would additionally eat Unicode whitespace such as
 *   U+FEFF, silently accepting ids the other side rejects. Keep in sync with
 *   `_normalize_user_id` (hermes-plugin/memory/memory_tencentdb/__init__.py).
 */

/**
 * Leading/trailing ASCII whitespace only (space + \t \n \v \f \r) — NOT
 * `String.prototype.trim()`, which also strips Unicode whitespace (U+FEFF,
 * U+00A0, …) and would diverge from the Python provider's `.strip(...)` pair.
 */
const ASCII_TRIM_RE = /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g;

/**
 * Valid uid shape after normalization. Full-string match, 1–64 chars of
 * `[a-z0-9_-]`. The restricted alphabet also guarantees `users/<uid>` paths
 * cannot traverse (`.` and `/` are not in the set).
 */
const USER_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

/** Legacy provider fallback id — always routes to the main store, without a warning. */
export const DEFAULT_USER_ID = "default";

/**
 * Normalize a raw user id.
 *
 * @returns the normalized id, or `null` when the input is not a string, is
 * empty after ASCII-trim, or does not fully match `^[a-z0-9_-]{1,64}$`.
 */
export function normalizeUserId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // `.toLowerCase()` folds exotic code points too — notably U+212A (KELVIN
  // SIGN) → ASCII "k". The Python provider's `str.lower()` behaves the same,
  // so both sides accept/identically-normalize such ids; no extra guarding
  // needed (recorded here so a future "fix" doesn't break the parity).
  const uid = raw.replace(ASCII_TRIM_RE, "").toLowerCase();
  if (!USER_ID_PATTERN.test(uid)) return null;
  return uid;
}

export interface UserIdRoutingOptions {
  /** Whether per-user stores are enabled (`multiUser.enabled`). */
  multiUserEnabled: boolean;
  /**
   * Owner user ids that keep using the main store. Entries are normalized
   * before comparison; invalid entries never match.
   */
  ownerUserIds: string[];
}

export interface UserIdRoutingResult {
  /** Normalized uid, or `null` when the raw input is invalid/missing. */
  uid: string | null;
  /** `"main"` = shared main store; `"user"` = per-user store `users/<uid>/`. */
  pool: "main" | "user";
  /** Whether the caller should emit a normalization-rejection warning. */
  warn: boolean;
}

/**
 * Decide which pool a request belongs to, from the raw `user_id` field.
 *
 * Pure function (no I/O, no logging) so the full routing matrix can be unit
 * tested. Authoritative rule order:
 *
 *   1. `multiUser.enabled === false`      → main, no warn
 *   2. uid invalid / missing              → main + warn
 *   3. uid ∈ ownerUserIds                 → main, no warn
 *   4. uid === "default" (legacy alias)   → main, no warn
 *   5. otherwise                          → user pool `users/<uid>/`
 */
export function resolveUserIdRouting(
  opts: UserIdRoutingOptions,
  raw: unknown,
): UserIdRoutingResult {
  const uid = normalizeUserId(raw);

  // 1. Feature off — legacy behaviour, everything lands in the main store.
  if (!opts.multiUserEnabled) {
    return { uid, pool: "main", warn: false };
  }

  // 2. Invalid / missing uid — fail-closed to the main store + warn.
  if (uid === null) {
    return { uid: null, pool: "main", warn: true };
  }

  // 3. Owners keep the main store (the main store already carries cron and
  //    identity-less traffic). Normalize each entry before comparing.
  const owners = new Set<string>();
  for (const owner of opts.ownerUserIds) {
    const normalized = normalizeUserId(owner);
    if (normalized !== null) owners.add(normalized);
  }
  if (owners.has(uid)) {
    return { uid, pool: "main", warn: false };
  }

  // 4. Legacy alias for the provider's static fallback id — main store, silent.
  if (uid === DEFAULT_USER_ID) {
    return { uid, pool: "main", warn: false };
  }

  // 5. Regular user — per-user store.
  return { uid, pool: "user", warn: false };
}
