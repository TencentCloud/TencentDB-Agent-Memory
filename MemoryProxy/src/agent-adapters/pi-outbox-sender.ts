import type { PiOutboxInput, PiOutboxReason, PiOutboxRecord } from "./pi-outbox-store.js";

export type PiDeliveryResult = { ok: true } | { ok: false; retryable: boolean; reason: PiOutboxReason };
export type PiOutboxSender = (record: PiOutboxRecord, signal: AbortSignal) => Promise<PiDeliveryResult>;

function failure(code: number): PiDeliveryResult {
  if (code === 409) return { ok: false, retryable: false, reason: "conflict" };
  if (code === 401 || code === 403) return { ok: false, retryable: false, reason: "auth" };
  return { ok: false, retryable: code === 408 || code === 429 || code >= 500,
    reason: code >= 500 ? "server" : "rejected" };
}

/**
 * A dedicated strict write path: the existing TdaiClient intentionally swallows
 * failures for fail-open recall, and must not be used as proof of durable ACK.
 * The caller must provision a #1142-capable gateway. Its response does not expose
 * capability negotiation, so compatibility cannot be inferred from HTTP 200.
 */
export function createPiOutboxSender(options: {
  endpoint: string;
  idempotencyContract: "1142";
  resolveApiKey: (scope: PiOutboxInput["scope"]) => string | Promise<string>;
}): PiOutboxSender {
  const endpoint = new URL(options.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || options.idempotencyContract !== "1142") {
    throw new Error("Expected a gateway base URL and explicit #1142 idempotency contract");
  }
  const url = `${endpoint.href.replace(/\/$/, "")}/v3/conversation/add`;
  return async (record, signal) => {
    try {
      const apiKey = await options.resolveApiKey(record.scope);
      if (!apiKey) return { ok: false, retryable: false, reason: "auth" };
      const response = await fetch(url, {
        method: "POST", signal, redirect: "error",
        headers: {
          "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`,
          "x-tdai-service-id": record.scope.serviceId, "x-tdai-team-id": record.scope.teamId,
          "x-tdai-agent-id": record.scope.agentId, "x-tdai-user-id": record.scope.userId,
          "x-tdai-session-id": record.scope.sessionId,
        },
        body: record.body,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return failure(response.status);
      }
      const envelope = await response.json();
      if (typeof envelope?.code === "number" && envelope.code !== 0) return failure(envelope.code);
      const count = JSON.parse(record.body).messages.length;
      const data = envelope?.data;
      if (envelope?.code !== 0 || !Array.isArray(data?.accepted_ids)
        || data.accepted_ids.length !== count || data.total_count !== count
        || !data.accepted_ids.every((id: unknown) => typeof id === "string" && id.length > 0)
        || new Set(data.accepted_ids).size !== count) {
        return { ok: false, retryable: true, reason: "malformed" };
      }
      return { ok: true };
    } catch (error) {
      // Never persist raw exception/response text: it may contain secrets or prompts.
      return { ok: false, retryable: true, reason: error instanceof SyntaxError ? "malformed" : "network" };
    }
  };
}
