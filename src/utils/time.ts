/**
 * Unified time module — the single source of truth for all timezone-aware
 * timestamp formatting in the plugin.
 *
 * Other modules MUST NOT directly call `toISOString()`, `getHours()`, or
 * `Intl.DateTimeFormat` for user/LLM-facing timestamps. Import from here instead.
 *
 * Design: module-level singleton. `initTimeModule()` is called once during
 * plugin registration; all subsequent calls read the resolved timezone.
 */

// ============================
// Internal state
// ============================

let _resolvedTz = "UTC"; // default, overwritten by initTimeModule()

interface Logger {
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}

let _logger: Logger | undefined;

// ============================
// Initialization
// ============================

/**
 * Initialize the time module. Called once during plugin register.
 * Subsequent hot-reloads also go through here.
 */
export function initTimeModule(cfg: { timezone?: string }, logger?: Logger): void {
  _resolvedTz = resolveTimeZone(cfg.timezone, logger);
  _logger = logger;
  _logger?.debug?.(`[time] Timezone resolved: "${_resolvedTz}"`);
}

/**
 * Returns the currently active IANA timezone name (or offset string).
 * Useful for diagnostics and prompt generation.
 */
export function getActiveTimeZone(): string {
  return _resolvedTz;
}

/**
 * @internal test-only — reset to pre-init state.
 * Avoids cross-test pollution when vitest runs multiple tests in the same process.
 */
export function _resetTimeModuleForTest(): void {
  _resolvedTz = "UTC";
  _logger = undefined;
}

// ============================
// A-type: UTC instants (for storage)
// ============================

/**
 * Current time as UTC ISO 8601 string with "Z" suffix.
 * Used for SQLite/TCVDB timestamps, cursors, and any machine-compared instants.
 */
export function nowInstantISO(): string {
  return new Date().toISOString();
}

// ============================
// B-type: Local date/datetime (follows configured tz)
// ============================

/**
 * Format a Date as "YYYY-MM-DD" in the configured timezone.
 * Used for L0 JSONL shard filenames and cleaner day boundaries.
 */
export function formatLocalDate(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: _resolvedTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

/**
 * Format a Date as "YYYY-MM-DD HH:mm:ss" in the configured timezone.
 * Used for cleaner audit logs and human-readable local timestamps.
 */
export function formatLocalDateTime(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: _resolvedTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Compute the start-of-day (00:00:00.000) in the configured timezone for a given date.
 * Returns a UTC millisecond timestamp.
 * Used by memory-cleaner for cutoff calculations.
 */
export function startOfLocalDay(d: Date = new Date()): number {
  // Get the local date components in the configured timezone
  const dateStr = formatLocalDate(d);
  // Parse as midnight in the configured timezone
  // Use a trick: format "YYYY-MM-DDT00:00:00" and find the UTC equivalent
  const midnightLocal = new Date(`${dateStr}T00:00:00`);

  // We need to find the UTC instant that corresponds to midnight in _resolvedTz.
  // Approach: binary search isn't needed — we can use the timezone offset.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: _resolvedTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Start with an estimate: the date at UTC midnight
  const utcMidnight = new Date(`${dateStr}T00:00:00Z`);
  // Check what local time that corresponds to
  const localParts = formatter.formatToParts(utcMidnight);
  const localHour = parseInt(localParts.find((p) => p.type === "hour")!.value, 10);
  const localMinute = parseInt(localParts.find((p) => p.type === "minute")!.value, 10);
  const localDay = localParts.find((p) => p.type === "day")!.value;
  const targetDay = dateStr.slice(8, 10); // DD from YYYY-MM-DD

  // The offset from UTC to local is: if UTC midnight shows as localHour:localMinute on localDay
  // then local midnight = UTC midnight - (localHour*60 + localMinute) minutes
  // But we need to handle day boundary crossings
  let offsetMinutes = localHour * 60 + localMinute;
  if (localDay !== targetDay) {
    // Day wrapped — means local is behind UTC (negative offset zones)
    // e.g. UTC midnight = previous day 19:00 in America/New_York
    offsetMinutes = offsetMinutes - 24 * 60;
  }

  // Local midnight in UTC = UTC midnight - offset
  return utcMidnight.getTime() - offsetMinutes * 60 * 1000;
}

// ============================
// C-type: LLM-facing timestamps (ISO 8601 with offset)
// ============================

/**
 * Format a timestamp for LLM consumption: ISO 8601 with explicit UTC offset.
 * Example: "2026-04-07T11:04:45+08:00"
 *
 * Handles:
 * - Date objects
 * - ISO 8601 strings (with or without "Z")
 * - Unix millisecond timestamps (numbers)
 *
 * Old UTC data ("Z" suffix) is correctly converted to the configured timezone.
 */
export function formatForLLM(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) {
    return String(input); // pass-through for unparseable values
  }

  // Get components in the configured timezone
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: _resolvedTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const dateTime = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;

  // Compute UTC offset for this instant in the configured timezone
  const offset = getUtcOffset(d);
  return `${dateTime}${offset}`;
}

/**
 * Generate a timezone declaration string for system prompts.
 * Example: "All timestamps below are in Asia/Shanghai (UTC+08:00). When reasoning about time, use this timezone."
 */
export function describeTimeZoneForPrompt(): string {
  const offset = getUtcOffset(new Date());
  return `All timestamps below are in ${_resolvedTz} (UTC${offset}). When reasoning about "yesterday", "last week", or time differences, use this timezone.`;
}

// ============================
// Internal helpers
// ============================

/**
 * Resolve the timezone configuration string to a validated timezone identifier.
 *
 * Accepts:
 * - "system" or undefined → process system timezone
 * - IANA names: "Asia/Shanghai", "Europe/Berlin", "UTC"
 * - UTC offset strings: "+08:00", "-05:30" (ECMA-402 2024)
 *
 * Invalid values fall back to system timezone with a warning.
 */
function resolveTimeZone(cfg: string | undefined, logger?: Logger): string {
  if (!cfg || cfg === "system") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  // Node 22+ Intl natively supports IANA names and UTC offset strings
  // per ECMA-402 2024 — no manual regex/Etc/GMT conversion needed.
  if (validateTimeZone(cfg)) return cfg;
  logger?.warn?.(`[time] Invalid timezone "${cfg}", falling back to system timezone`);
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Validate a timezone string using the Intl API.
 * Works for IANA names and UTC offset strings ("+05:30", "-08:00").
 */
function validateTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the UTC offset string (e.g. "+08:00", "-05:30", "+00:00")
 * for a given instant in the configured timezone.
 */
function getUtcOffset(d: Date): string {
  // Strategy: compare the "wall clock" time in the target tz vs UTC
  // to derive the offset for this specific instant (handles DST).
  const utcParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const localParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: _resolvedTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const toMinutes = (parts: Intl.DateTimeFormatPart[]) => {
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);
    const y = get("year"), mo = get("month"), day = get("day");
    const h = get("hour"), mi = get("minute");
    // Convert to a comparable minute-of-epoch (approximate, good enough for offset calc)
    return ((y * 12 + mo) * 31 + day) * 24 * 60 + h * 60 + mi;
  };

  const diffMinutes = toMinutes(localParts) - toMinutes(utcParts);
  const sign = diffMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(diffMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}
