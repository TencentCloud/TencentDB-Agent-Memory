/**
 * Optional time window for LLM-backed pipeline tasks (L1/L2/L3/flush).
 *
 * Why defer instead of fail: a task that fails hard enough lands in
 * `moveToDeadLetter()`, which removes the session's `L1_idle` and
 * `L2_schedule` timers. Nothing re-arms them afterwards, so that session
 * silently stops being extracted for good. Deferring is safe because L1
 * extracts against a cursor — an un-run task leaves the cursor untouched and
 * the backlog is still there at the next opening.
 *
 * Disabled by default; opt in with `TDAI_LLM_WINDOW=on`.
 *
 *   TDAI_LLM_WINDOW=on|off        enable the gate (default: off)
 *   TDAI_LLM_WINDOW_HOURS=9-18    weekday hours that stay closed (default: 9-18)
 *
 * Weekends are always open. Outside the configured block the window is open,
 * so an unset/off configuration never defers anything.
 */

const DEFAULT_CLOSED_FROM_HOUR = 9;
const DEFAULT_CLOSED_UNTIL_HOUR = 18;

interface ClosedRange {
  /** Hour at which the closed block starts (inclusive). */
  fromHour: number;
  /** Hour at which the closed block ends (exclusive). */
  untilHour: number;
}

function isEnabled(): boolean {
  return (process.env.TDAI_LLM_WINDOW ?? "off").trim().toLowerCase() === "on";
}

function parseHours(raw: string | undefined): ClosedRange {
  const fallback: ClosedRange = {
    fromHour: DEFAULT_CLOSED_FROM_HOUR,
    untilHour: DEFAULT_CLOSED_UNTIL_HOUR,
  };
  if (!raw) return fallback;

  const match = raw.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!match) return fallback;

  const fromHour = Number(match[1]);
  const untilHour = Number(match[2]);
  const valid = (h: number): boolean => Number.isInteger(h) && h >= 0 && h <= 24;
  if (!valid(fromHour) || !valid(untilHour) || fromHour >= untilHour) return fallback;

  return { fromHour, untilHour };
}

function closedRange(): ClosedRange {
  return parseHours(process.env.TDAI_LLM_WINDOW_HOURS);
}

/** True when LLM pipeline tasks are allowed to run at `now`. */
export function isLlmWindowOpen(now: Date = new Date()): boolean {
  if (!isEnabled()) return true;

  const day = now.getDay(); // 0 = Sunday … 6 = Saturday
  if (day === 0 || day === 6) return true;

  const { fromHour, untilHour } = closedRange();
  const hour = now.getHours();
  return hour < fromHour || hour >= untilHour;
}

/**
 * Epoch ms of the next window opening; `now` when the window is already open.
 *
 * Weekends are open and the closed block never wraps past midnight, so the
 * next opening is always `untilHour` later the same day.
 */
export function nextLlmWindowOpenMs(now: Date = new Date()): number {
  if (isLlmWindowOpen(now)) return now.getTime();

  const next = new Date(now);
  next.setHours(closedRange().untilHour, 0, 0, 0);
  return next.getTime();
}

/**
 * Timer suffix to re-arm for a deferred task, or null when the task is not an
 * LLM task and must not be deferred.
 *
 * These reuse suffixes the scheduler already understands (see
 * `buildPipelineTimerMember` / `classifyTimerType`): `L1*` routes to L1,
 * `L2*` to L2, `L3*` to L3. `offload-*` is a local LLM task and is left alone.
 */
export function deferredTimerType(taskType: string): string | null {
  switch (taskType) {
    case "L1":
    case "flush":
      return "L1_idle";
    case "L2":
      return "L2_schedule";
    case "L3":
      return "L3_deferred";
    default:
      return null;
  }
}
