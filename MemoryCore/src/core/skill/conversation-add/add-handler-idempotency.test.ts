import { describe, expect, it, vi } from "vitest";
import { SkillConversationAddHandler, SkillIdempotencyConflictError } from "./add-handler.js";

function input(answer = "a") {
  return {
    instance_id: "service", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent",
    session_id: "session", idempotency_key: "turn-1",
    messages: [
      { role: "user" as const, content: "q", timestamp: 1 },
      { role: "assistant" as const, content: answer, timestamp: 2 },
    ],
  };
}

describe("Skill conversation idempotency", () => {
  it("replays the same result without appending the buffered messages twice", async () => {
    let current: { messages: Array<Record<string, unknown>> } = { messages: [] };
    let receipt: any = null;
    const buffer = {
      readCurrent: vi.fn(async () => current),
      readMeta: vi.fn(async () => ({ session_id: "session", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent", tool_call_count: 0, byte_count: 0 })),
      writeCurrent: vi.fn(async (_sess: unknown, value: typeof current) => { current = value; }),
      writeMeta: vi.fn(async () => {}),
      readIdempotencyReceipt: vi.fn(async () => receipt),
      writeIdempotencyReceipt: vi.fn(async (_sess: unknown, value: unknown) => { receipt = value; }),
      findIdempotencyMarker: vi.fn(async () => null),
    };
    const handler = new SkillConversationAddHandler({ buffer: buffer as never, trigger: {} as never });

    const first = await handler.handle(input());
    const second = await handler.handle(input());

    expect(first).toEqual({ status: "ok" });
    expect(second).toEqual(first);
    expect(buffer.writeCurrent).toHaveBeenCalledTimes(1);
    expect(buffer.writeIdempotencyReceipt).toHaveBeenCalledTimes(1);
  });

  it("rejects reusing a key with a different payload", async () => {
    const buffer = {
      readCurrent: vi.fn(async () => ({ messages: [] })),
      readMeta: vi.fn(async () => ({ session_id: "session", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent", tool_call_count: 0, byte_count: 0 })),
      writeCurrent: vi.fn(async () => {}),
      writeMeta: vi.fn(async () => {}),
      readIdempotencyReceipt: vi.fn(async () => ({ version: 1, key_hash: "ignored", payload_digest: "different", result: { status: "ok" }, created_at_ms: 1 })),
      writeIdempotencyReceipt: vi.fn(async () => {}),
      findIdempotencyMarker: vi.fn(async () => null),
    };
    const handler = new SkillConversationAddHandler({ buffer: buffer as never, trigger: {} as never });

    await expect(handler.handle(input())).rejects.toBeInstanceOf(SkillIdempotencyConflictError);
  });
});
