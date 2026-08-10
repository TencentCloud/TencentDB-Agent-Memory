/**
 * Timezone helpers for role scheduling (memory.timezone, default "system").
 * Extracted from night-run.ts so the timer file stays within the module size
 * convention once the dispatcher loop moves in; behaviour is unchanged and
 * still covered by night-run.test.ts.
 */

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Current wall-clock parts in the configured zone. "system" uses local time;
 * IANA names / UTC offsets go through Intl.DateTimeFormat (ECMA-402 2024).
 * An invalid zone falls back to system time (fail-safe — the timer must not
 * crash the gateway over a typo).
 */
export function zonedParts(nowMs: number, timezone: string): ZoneParts {
  const d = new Date(nowMs);
  if (!timezone || timezone === "system") {
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
    };
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(d);
    const get = (type: string): number => {
      const v = parts.find((p) => p.type === type)?.value;
      return v === undefined ? 0 : Number(v);
    };
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
    };
  } catch {
    return zonedParts(nowMs, "system");
  }
}

/** Parse a normalized "HH:MM" schedule (fallback 06:00 on malformed input). */
export function parseSchedule(schedule: string): {
  hour: number;
  minute: number;
} {
  const m = /^(\d{2}):(\d{2})$/.exec(schedule);
  if (!m) return { hour: 6, minute: 0 };
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** True when the schedule moment for TODAY has already passed in the zone. */
export function scheduleDueInZone(
  nowMs: number,
  schedule: string,
  timezone: string,
): boolean {
  const p = zonedParts(nowMs, timezone);
  const s = parseSchedule(schedule);
  return p.hour > s.hour || (p.hour === s.hour && p.minute >= s.minute);
}

/** True when `iso` falls on the same zone-local day as `nowMs`. */
export function sameZoneDay(
  nowMs: number,
  iso: string,
  timezone: string,
): boolean {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return false;
  const a = zonedParts(nowMs, timezone);
  const b = zonedParts(ts, timezone);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}
