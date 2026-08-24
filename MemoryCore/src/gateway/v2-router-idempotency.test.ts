import { describe, expect, it } from "vitest";
import {
  buildConversationIdempotencyScope,
  conversationAddRequestSchema,
  digestConversationAddPayload,
  serializeConversationIdempotencyScope,
} from "./v2-schemas.js";

describe("conversation add idempotency contract", () => {
  const request = {
    session_id: "session-1",
    messages: [{ role: "user" as const, content: "hello", timestamp: "2026-08-24T00:00:00.000Z" }],
  };

  it("preserves unkeyed conversation add requests", () => {
    expect(conversationAddRequestSchema.safeParse(request).success).toBe(true);
  });

  it("accepts an opaque idempotency key", () => {
    const parsed = conversationAddRequestSchema.safeParse({ ...request, idempotency_key: "turn_01-ABC.def:retry" });

    expect(parsed.success).toBe(true);
  });

  it.each(["", "   ", "has spaces", "slash/key", "x".repeat(257)])(
    "rejects invalid idempotency key %j",
    (idempotency_key) => {
      expect(conversationAddRequestSchema.safeParse({ ...request, idempotency_key }).success).toBe(false);
    },
  );

  it("serializes every scope dimension in a stable field order", () => {
    const scope = buildConversationIdempotencyScope({
      serviceId: "service-1",
      teamId: "team-1",
      agentId: "agent-1",
      userId: "user-1",
      sessionId: "session-1",
      idempotencyKey: "turn-1",
    });

    expect(serializeConversationIdempotencyScope(scope)).toBe(
      "service_id=service-1&team_id=team-1&agent_id=agent-1&user_id=user-1&session_id=session-1&idempotency_key=turn-1",
    );
  });

  it("digests the normalized payload without its idempotency key", () => {
    expect(digestConversationAddPayload({ ...request, idempotency_key: "turn-1" })).toBe(
      "7393f98ee3fd81dcae482a29a7465f2c3268431b561843b763eae91018719d9f",
    );
    expect(digestConversationAddPayload({ ...request, idempotency_key: "turn-2" })).toBe(
      "7393f98ee3fd81dcae482a29a7465f2c3268431b561843b763eae91018719d9f",
    );
  });

  it("does not reuse a digest when an ordered message changes", () => {
    const original = digestConversationAddPayload(request);
    const changed = digestConversationAddPayload({
      ...request,
      messages: [{ ...request.messages[0], content: "goodbye" }],
    });

    expect(changed).not.toBe(original);
  });
});
