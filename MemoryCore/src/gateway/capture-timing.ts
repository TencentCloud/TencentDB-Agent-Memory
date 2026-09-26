/**
 * Derive the capture cursor floor from caller-supplied message timestamps.
 *
 * Gateway captures do not have the host lifecycle's real plugin start time. When
 * timestamps are supplied (for retry-safe MCP capture or historical import), using
 * `Date.now()` as the floor would discard every message as already historical.
 */
export function captureCursorFloor(messages: unknown[] | undefined): number | undefined {
  if (!messages) return undefined;

  const timestamps = messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    return typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp > 0
      ? [timestamp]
      : [];
  });

  if (timestamps.length === 0) return undefined;
  return Math.max(0, Math.min(...timestamps) - 1);
}
