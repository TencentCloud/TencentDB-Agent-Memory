import type { SubscriptionQuotaWindow } from "../metadata/types.js";

function windowKey(window: SubscriptionQuotaWindow): string {
  return `${window.name}\0${window.model_scope ?? ""}`;
}

/**
 * Newest observation wins per window. A 429 observation always wins and stays at 100 % until
 * its reset time; a 429 window without a reset time does not block newer readings.
 */
export function mergeUsageWindows(current: SubscriptionQuotaWindow[], incoming: SubscriptionQuotaWindow[]): SubscriptionQuotaWindow[] {
  const byKey = new Map(current.map((window) => [windowKey(window), window]));
  for (const next of incoming) {
    const key = windowKey(next);
    const previous = byKey.get(key);
    if (!previous || next.source === "429") {
      byKey.set(key, next);
      continue;
    }
    const held429 = previous.source === "429" && previous.resets_at !== null && next.observed_at < previous.resets_at;
    if (!held429 && next.observed_at >= previous.observed_at) byKey.set(key, next);
  }
  return [...byKey.values()];
}
