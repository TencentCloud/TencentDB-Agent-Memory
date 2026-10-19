import type { CaptureRequest } from "./types.js";

const syntheticCaptureTimestampsBySession = new Map<string, number>();

export function buildGatewayCaptureTurn(body: CaptureRequest, now = Date.now()): {
  messages: unknown[];
  startedAt: number;
} {
  if (Array.isArray(body.messages)) {
    const timestampRange = messageTimestampRange(body.messages);
    if (timestampRange) {
      const lastTimestamp = syntheticCaptureTimestampsBySession.get(body.session_key) ?? 0;
      if (timestampRange.max > lastTimestamp) {
        syntheticCaptureTimestampsBySession.set(body.session_key, timestampRange.max);
      }
    }
    const floorBase = timestampRange ? Math.min(now, timestampRange.min) : now;
    return { messages: body.messages, startedAt: floorBase - 1 };
  }

  const lastTimestamp = syntheticCaptureTimestampsBySession.get(body.session_key) ?? 0;
  const baseTimestamp = Math.max(now, lastTimestamp);
  const userTimestamp = baseTimestamp + 1;
  const assistantTimestamp = baseTimestamp + 2;
  syntheticCaptureTimestampsBySession.set(body.session_key, assistantTimestamp);

  return {
    messages: [
      { role: "user", content: body.user_content, timestamp: userTimestamp },
      { role: "assistant", content: body.assistant_content, timestamp: assistantTimestamp },
    ],
    startedAt: now,
  };
}

function messageTimestampRange(messages: unknown[]): { min: number; max: number } | undefined {
  let maxTimestamp: number | undefined;
  let minTimestamp: number | undefined;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const timestamp = (message as Record<string, unknown>).timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
    maxTimestamp = maxTimestamp == null ? timestamp : Math.max(maxTimestamp, timestamp);
    minTimestamp = minTimestamp == null ? timestamp : Math.min(minTimestamp, timestamp);
  }
  return minTimestamp == null || maxTimestamp == null
    ? undefined
    : { min: minTimestamp, max: maxTimestamp };
}
