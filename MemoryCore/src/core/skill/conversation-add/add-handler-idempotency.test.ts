import { describe, expect, it, vi } from "vitest";
import { SkillConversationAddHandler, SkillIdempotencyConflictError } from "./add-handler.js";
import { LocalSkillAgentTaskQueue } from "./agent-task-queue.js";

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
  it("serializes the same session across handler instances before checking idempotency", async () => {
    let current: any = { messages: [] };
    let meta: any = {
      session_id: "session", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent",
      tool_call_count: 0, byte_count: 0,
    };
    const receipts = new Map<string, any>();
    const buffer = {
      readCurrent: vi.fn(async () => current),
      readMeta: vi.fn(async () => meta),
      writeCurrent: vi.fn(async (_sess: unknown, value: any) => { current = value; }),
      writeMeta: vi.fn(async (_sess: unknown, value: any) => { meta = value; }),
      readIdempotencyReceipt: vi.fn(async (_sess: unknown, keyHash: string) => receipts.get(keyHash) ?? null),
      writeIdempotencyReceipt: vi.fn(async (_sess: unknown, value: any) => { receipts.set(value.key_hash, value); }),
      findIdempotencyMarker: vi.fn(async () => null),
    };
    const queue = new LocalSkillAgentTaskQueue();
    const first = new SkillConversationAddHandler({ buffer: buffer as never, trigger: {} as never, queue });
    const second = new SkillConversationAddHandler({ buffer: buffer as never, trigger: {} as never, queue });

    const results = await Promise.allSettled([first.handle(input("a")), second.handle(input("different"))]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(SkillIdempotencyConflictError);
    expect(current.messages).toHaveLength(2);
    expect(["a", "different"]).toContain(current.messages[1]?.content);
  });

  it("does not lose messages when different keys hit separate handlers for one session", async () => {
    let current: any = { messages: [] };
    let meta: any = {
      session_id: "session", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent",
      tool_call_count: 0, byte_count: 0,
    };
    const receipts = new Map<string, any>();
    const buffer = {
      readCurrent: vi.fn(async () => current),
      readMeta: vi.fn(async () => meta),
      writeCurrent: vi.fn(async (_sess: unknown, value: any) => { current = value; }),
      writeMeta: vi.fn(async (_sess: unknown, value: any) => { meta = value; }),
      readIdempotencyReceipt: vi.fn(async (_sess: unknown, keyHash: string) => receipts.get(keyHash) ?? null),
      writeIdempotencyReceipt: vi.fn(async (_sess: unknown, value: any) => { receipts.set(value.key_hash, value); }),
      findIdempotencyMarker: vi.fn(async () => null),
    };
    const queue = new LocalSkillAgentTaskQueue();
    const first = new SkillConversationAddHandler({ buffer: buffer as never, trigger: {} as never, queue });
    const second = new SkillConversationAddHandler({ buffer: buffer as never, trigger: {} as never, queue });
    const secondInput = {
      ...input("b"), idempotency_key: "turn-2",
      messages: [{ role: "user" as const, content: "q2" }, { role: "assistant" as const, content: "b" }],
    };

    await Promise.all([first.handle(input()), second.handle(secondInput)]);

    expect(current.messages).toHaveLength(4);
    expect(current.messages.map((message: any) => message.content).sort()).toEqual(["a", "b", "q", "q2"]);
    expect(receipts.size).toBe(2);
  });

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

    const [first, second] = await Promise.all([handler.handle(input()), handler.handle(input())]);

    expect(first).toEqual({ status: "ok" });
    expect(second).toEqual(first);
    expect(buffer.writeCurrent).toHaveBeenCalledTimes(1);
    expect(buffer.writeIdempotencyReceipt).toHaveBeenCalledTimes(1);
    expect((handler as unknown as { sessionChains: Map<string, Promise<unknown>> }).sessionChains.size).toBe(0);
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
    expect((handler as unknown as { sessionChains: Map<string, Promise<unknown>> }).sessionChains.size).toBe(0);
  });

  it("finishes archive write-back after a crash without leaving stale current messages", async () => {
    let current: any = { messages: [{ role: "user", content: "older" }] };
    let meta: any = {
      session_id: "session", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent",
      tool_call_count: 0, byte_count: 35,
    };
    let receipt: any = null;
    let archive: any = null;
    const writeCurrent = vi.fn()
      .mockRejectedValueOnce(new Error("simulated crash before current reset"))
      .mockImplementation(async (_sess: unknown, value: any) => { current = value; });
    const writeMeta = vi.fn(async (_sess: unknown, value: any) => { meta = value; });
    const buffer = {
      readCurrent: vi.fn(async () => current),
      readMeta: vi.fn(async () => meta),
      writeCurrent,
      writeMeta,
      readIdempotencyReceipt: vi.fn(async () => receipt),
      writeIdempotencyReceipt: vi.fn(async (_sess: unknown, value: unknown) => { receipt = value; }),
      findIdempotencyMarker: vi.fn(async (_sess: unknown, keyHash: string) => {
        const marker = archive?.idempotency_markers?.find((item: any) => item.key_hash === keyHash);
        if (!marker) return null;
        return {
          kind: "archive", archiveKey: "data-idem.jsonl", messages: archive.messages,
          idempotency: marker,
        };
      }),
    };
    const trigger = {
      archive: vi.fn(async ({ bufferAtTrigger }: any) => {
        archive = bufferAtTrigger;
        return { taskId: "task-1", archivedAtMs: 1234, archiveKey: "data-idem.jsonl" };
      }),
    };
    const handler = new SkillConversationAddHandler({
      buffer: buffer as never,
      trigger: trigger as never,
      thresholds: { bytesThreshold: 1, requestCompressThresholdBytes: 1_000_000 },
      now: () => 1234,
    });

    await expect(handler.handle(input())).rejects.toThrow("simulated crash");
    expect(writeMeta).not.toHaveBeenCalled();

    const recovered = await handler.handle(input());

    expect(recovered).toEqual({
      status: "archived",
      archived: { task_id: "task-1", archived_at_ms: 1234, archive_key: "data-idem.jsonl", reason: "bytes" },
    });
    expect(current.messages).toEqual([]);
    expect(meta).toMatchObject({ tool_call_count: 0, byte_count: 0, last_archived_at_ms: 1234 });
    expect(trigger.archive).toHaveBeenCalledTimes(2);
    expect(receipt?.result).toEqual(recovered);
  });

  it("recovers an older archive after a later archive already cleared current", async () => {
    let current: any = { messages: [{ role: "user", content: "older" }] };
    let meta: any = {
      session_id: "session", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent",
      tool_call_count: 0, byte_count: 35,
    };
    const archives: any[] = [];
    const receipts = new Map<string, any>();
    const writeCurrent = vi.fn()
      .mockRejectedValueOnce(new Error("simulated crash before first current reset"))
      .mockImplementation(async (_sess: unknown, value: any) => { current = value; });
    const buffer = {
      readCurrent: vi.fn(async () => current),
      readMeta: vi.fn(async () => meta),
      writeCurrent,
      writeMeta: vi.fn(async (_sess: unknown, value: any) => { meta = value; }),
      readIdempotencyReceipt: vi.fn(async (_sess: unknown, keyHash: string) => receipts.get(keyHash) ?? null),
      writeIdempotencyReceipt: vi.fn(async (_sess: unknown, value: any) => { receipts.set(value.key_hash, value); }),
      findIdempotencyMarker: vi.fn(async (_sess: unknown, keyHash: string) => {
        for (const archive of archives) {
          const marker = archive.buffer.idempotency_markers?.find((item: any) => item.key_hash === keyHash);
          if (marker) {
            return {
              kind: "archive", archiveKey: archive.archiveKey, messages: archive.buffer.messages,
              idempotency: marker,
            };
          }
        }
        return null;
      }),
    };
    let archiveCall = 0;
    const trigger = {
      archive: vi.fn(async ({ bufferAtTrigger }: any) => {
        archiveCall += 1;
        if (archiveCall === 3) {
          return { taskId: "task-1", archivedAtMs: 1000, archiveKey: "data-idem-1.jsonl" };
        }
        const result = archiveCall === 1
          ? { taskId: "task-1", archivedAtMs: 1000, archiveKey: "data-idem-1.jsonl" }
          : { taskId: "task-2", archivedAtMs: 2000, archiveKey: "data-idem-2.jsonl" };
        archives.push({ buffer: bufferAtTrigger, archiveKey: result.archiveKey });
        return result;
      }),
    };
    const handler = new SkillConversationAddHandler({
      buffer: buffer as never,
      trigger: trigger as never,
      thresholds: { bytesThreshold: 1, requestCompressThresholdBytes: 1_000_000 },
      now: () => 2000,
    });
    const secondInput = {
      ...input("b"), idempotency_key: "turn-2",
      messages: [{ role: "user" as const, content: "q2" }, { role: "assistant" as const, content: "b" }],
    };

    await expect(handler.handle(input())).rejects.toThrow("simulated crash");
    await expect(handler.handle(secondInput)).resolves.toMatchObject({ status: "archived" });
    const recovered = await handler.handle(input());

    expect(recovered).toEqual({
      status: "archived",
      archived: { task_id: "task-1", archived_at_ms: 1000, archive_key: "data-idem-1.jsonl", reason: "bytes" },
    });
    expect(current.messages).toEqual([]);
    expect(meta).toMatchObject({ tool_call_count: 0, byte_count: 0, last_archived_at_ms: 2000 });
    expect(trigger.archive).toHaveBeenCalledTimes(3);
    expect(receipts.size).toBe(2);
  });

  it("repairs meta after current was written but the write-back was interrupted", async () => {
    let current: any = { messages: [] };
    let meta: any = {
      session_id: "session", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent",
      tool_call_count: 0, byte_count: 0,
    };
    let receipt: any = null;
    const writeCurrent = vi.fn(async (_sess: unknown, value: any) => { current = value; });
    const writeMeta = vi.fn()
      .mockRejectedValueOnce(new Error("simulated crash before meta write"))
      .mockImplementation(async (_sess: unknown, value: any) => { meta = value; });
    const buffer = {
      readCurrent: vi.fn(async () => current),
      readMeta: vi.fn(async () => meta),
      writeCurrent,
      writeMeta,
      readIdempotencyReceipt: vi.fn(async () => receipt),
      writeIdempotencyReceipt: vi.fn(async (_sess: unknown, value: unknown) => { receipt = value; }),
      findIdempotencyMarker: vi.fn(async (_sess: unknown, keyHash: string) => {
        const marker = current.idempotency_markers?.find((item: any) => item.key_hash === keyHash);
        return marker
          ? { kind: "current", messages: current.messages, idempotency: marker }
          : null;
      }),
    };
    const handler = new SkillConversationAddHandler({ buffer: buffer as never, trigger: {} as never, now: () => 1234 });

    await expect(handler.handle(input())).rejects.toThrow("simulated crash");
    const recovered = await handler.handle(input());

    expect(recovered).toEqual({ status: "ok" });
    expect(writeCurrent).toHaveBeenCalledTimes(1);
    expect(writeMeta).toHaveBeenCalledTimes(2);
    expect(meta.byte_count).toBeGreaterThan(0);
    expect(receipt?.result).toEqual(recovered);
  });

  it("keeps an earlier recovery marker when a later request is persisted", async () => {
    let current: any = { messages: [] };
    let meta: any = {
      session_id: "session", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent",
      tool_call_count: 0, byte_count: 0,
    };
    const receipts = new Map<string, any>();
    const writeReceipt = vi.fn()
      .mockRejectedValueOnce(new Error("simulated receipt failure"))
      .mockImplementation(async (_sess: unknown, value: any) => { receipts.set(value.key_hash, value); });
    const buffer = {
      readCurrent: vi.fn(async () => current),
      readMeta: vi.fn(async () => meta),
      writeCurrent: vi.fn(async (_sess: unknown, value: any) => { current = value; }),
      writeMeta: vi.fn(async (_sess: unknown, value: any) => { meta = value; }),
      readIdempotencyReceipt: vi.fn(async (_sess: unknown, keyHash: string) => receipts.get(keyHash) ?? null),
      writeIdempotencyReceipt: writeReceipt,
      findIdempotencyMarker: vi.fn(async (_sess: unknown, keyHash: string) => {
        const marker = current.idempotency_markers?.find((item: any) => item.key_hash === keyHash);
        return marker ? { kind: "current", messages: current.messages, idempotency: marker } : null;
      }),
    };
    const handler = new SkillConversationAddHandler({ buffer: buffer as never, trigger: {} as never });
    const secondInput = {
      ...input("b"), idempotency_key: "turn-2",
      messages: [{ role: "user" as const, content: "q2" }, { role: "assistant" as const, content: "b" }],
    };

    await expect(handler.handle(input())).rejects.toThrow("simulated receipt failure");
    await expect(handler.handle(secondInput)).resolves.toEqual({ status: "ok" });
    await expect(handler.handle(input())).resolves.toEqual({ status: "ok" });

    expect(current.messages.map((message: any) => message.content)).toEqual(["q", "a", "q2", "b"]);
    expect(current.idempotency_markers).toHaveLength(2);
    expect(buffer.writeCurrent).toHaveBeenCalledTimes(2);
    expect(receipts.size).toBe(2);
  });

  it("replays a normal request from a later archive without creating a duplicate task", async () => {
    let current: any = { messages: [] };
    let meta: any = {
      session_id: "session", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent",
      tool_call_count: 0, byte_count: 0,
    };
    let archive: any = null;
    const receipts = new Map<string, any>();
    const writeReceipt = vi.fn()
      .mockRejectedValueOnce(new Error("simulated receipt failure"))
      .mockImplementation(async (_sess: unknown, value: any) => { receipts.set(value.key_hash, value); });
    const buffer = {
      readCurrent: vi.fn(async () => current),
      readMeta: vi.fn(async () => meta),
      writeCurrent: vi.fn(async (_sess: unknown, value: any) => { current = value; }),
      writeMeta: vi.fn(async (_sess: unknown, value: any) => { meta = value; }),
      readIdempotencyReceipt: vi.fn(async (_sess: unknown, keyHash: string) => receipts.get(keyHash) ?? null),
      writeIdempotencyReceipt: writeReceipt,
      findIdempotencyMarker: vi.fn(async (_sess: unknown, keyHash: string) => {
        const currentMarker = current.idempotency_markers?.find((item: any) => item.key_hash === keyHash);
        if (currentMarker) return { kind: "current", messages: current.messages, idempotency: currentMarker };
        const archiveMarker = archive?.idempotency_markers?.find((item: any) => item.key_hash === keyHash);
        return archiveMarker ? { kind: "archive", messages: archive.messages, idempotency: archiveMarker } : null;
      }),
    };
    const trigger = {
      archive: vi.fn(async ({ bufferAtTrigger }: any) => {
        archive = bufferAtTrigger;
        return { taskId: "task-2", archivedAtMs: 2000, archiveKey: "data-idem-2.jsonl" };
      }),
    };
    const normalHandler = new SkillConversationAddHandler({ buffer: buffer as never, trigger: trigger as never });
    const archiveHandler = new SkillConversationAddHandler({
      buffer: buffer as never, trigger: trigger as never, thresholds: { bytesThreshold: 1 }, now: () => 2000,
    });
    const secondInput = {
      ...input("b"), idempotency_key: "turn-2",
      messages: [{ role: "user" as const, content: "q2" }, { role: "assistant" as const, content: "b" }],
    };

    await expect(normalHandler.handle(input())).rejects.toThrow("simulated receipt failure");
    await expect(archiveHandler.handle(secondInput)).resolves.toMatchObject({ status: "archived" });
    await expect(normalHandler.handle(input())).resolves.toEqual({ status: "ok" });

    expect(trigger.archive).toHaveBeenCalledTimes(1);
    expect(current.messages).toEqual([]);
    expect(receipts.size).toBe(2);
  });
});
