import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VectorStore } from "./sqlite.js";
import type { ClaimConversationAddInput, ConversationIdempotencyScope } from "./types.js";

const scope: ConversationIdempotencyScope = {
  serviceId: "service-1",
  teamId: "team-1",
  agentId: "agent-1",
  userId: "user-1",
  sessionId: "session-1",
  idempotencyKey: "turn-1",
};

function input(overrides: Partial<ClaimConversationAddInput> = {}): ClaimConversationAddInput {
  return {
    scope,
    payloadDigest: "digest-1",
    pipelineRounds: 2,
    records: [
      {
        id: "message-1",
        sessionKey: "session-1",
        sessionId: "session-1",
        teamId: "team-1",
        agentId: "agent-1",
        userId: "user-1",
        role: "user",
        messageText: "hello",
        recordedAt: "2026-08-24T00:00:00.000Z",
        timestamp: 1787529600000,
      },
      {
        id: "message-2",
        sessionKey: "session-1",
        sessionId: "session-1",
        teamId: "team-1",
        agentId: "agent-1",
        userId: "user-1",
        role: "assistant",
        messageText: "world",
        recordedAt: "2026-08-24T00:00:01.000Z",
        timestamp: 1787529601000,
      },
    ],
    ...overrides,
  };
}

describe("VectorStore conversation add idempotency", () => {
  const stores: VectorStore[] = [];
  const directories: string[] = [];

  function createStore(): VectorStore {
    const directory = mkdtempSync(path.join(os.tmpdir(), "tdai-sqlite-idempotency-"));
    directories.push(directory);
    const store = new VectorStore(path.join(directory, "vectors.db"), 0);
    store.init();
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("persists a claimed receipt, all L0 rows, and one pending outbox event together", () => {
    const store = createStore();

    const claim = store.claimConversationAdd(input());

    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") return;
    expect(claim.receipt).toMatchObject({
      scope,
      payloadDigest: "digest-1",
      acceptedIds: ["message-1", "message-2"],
      status: "pending",
    });
    expect(claim.outboxEvent).toMatchObject({
      receiptId: claim.receipt.receiptId,
      serviceId: "service-1",
      sessionId: "session-1",
      teamId: "team-1",
      agentId: "agent-1",
      rounds: 2,
      status: "pending",
    });
    expect(store.queryL0ForL1("session-1", undefined, 10).map((row) => row.record_id)).toEqual([
      "message-1",
      "message-2",
    ]);
    expect(store.readConversationAddReceipt(scope)).toMatchObject({
      receiptId: claim.receipt.receiptId,
      acceptedIds: ["message-1", "message-2"],
      status: "pending",
    });
  });

  it("replays the original IDs for a repeated scope and digest", () => {
    const store = createStore();
    const first = store.claimConversationAdd(input());
    const replay = store.claimConversationAdd(input({
      records: [{ ...input().records[0], id: "would-be-duplicate" }],
    }));

    expect(first.status).toBe("claimed");
    expect(replay.status).toBe("replay");
    if (first.status !== "claimed" || replay.status !== "replay") return;
    expect(replay.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(replay.receipt.acceptedIds).toEqual(["message-1", "message-2"]);
    expect(replay.outboxEvent?.eventId).toBe(first.outboxEvent.eventId);
    expect(store.queryL0ForL1("session-1", undefined, 10).map((row) => row.record_id)).toEqual([
      "message-1",
      "message-2",
    ]);
  });

  it("rejects a repeated scope with a different payload digest", () => {
    const store = createStore();
    store.claimConversationAdd(input());

    expect(store.claimConversationAdd(input({ payloadDigest: "different-digest" }))).toEqual({ status: "conflict" });
  });

  it("rolls back an L0 write failure so the same request can be claimed again", () => {
    const store = createStore();
    store.getRawDb().exec(`
      CREATE TRIGGER fail_l0_admission
      BEFORE INSERT ON l0_conversations
      WHEN NEW.record_id = 'message-1'
      BEGIN
        SELECT RAISE(ABORT, 'inject l0 failure');
      END
    `);

    expect(() => store.claimConversationAdd(input())).toThrow("inject l0 failure");
    expect(store.readConversationAddReceipt(scope)).toBeNull();
    expect(store.getRawDb().prepare("SELECT COUNT(*) AS count FROM conversation_add_outbox").get()).toEqual({ count: 0 });
    expect(store.queryL0ForL1("session-1", undefined, 10)).toEqual([]);

    store.getRawDb().exec("DROP TRIGGER fail_l0_admission");
    expect(store.claimConversationAdd(input()).status).toBe("claimed");
  });

  it("atomically leaves receipt and outbox pending when acknowledgement cannot complete the receipt", () => {
    const store = createStore();
    const claim = store.claimConversationAdd(input());
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") return;
    store.getRawDb().exec(`
      CREATE TRIGGER fail_receipt_completion
      BEFORE UPDATE OF status ON conversation_add_receipts
      WHEN NEW.status = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'inject receipt completion failure');
      END
    `);

    expect(() => store.ackConversationOutbox(claim.outboxEvent.eventId)).toThrow("inject receipt completion failure");
    expect(store.readConversationAddReceipt(scope)?.status).toBe("pending");
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_outbox WHERE event_id = ?").get(claim.outboxEvent.eventId)).toEqual({ status: "pending" });

    store.getRawDb().exec("DROP TRIGGER fail_receipt_completion");
    expect(store.ackConversationOutbox(claim.outboxEvent.eventId)).toBe(true);
    expect(store.readConversationAddReceipt(scope)?.status).toBe("completed");
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_outbox WHERE event_id = ?").get(claim.outboxEvent.eventId)).toEqual({ status: "acknowledged" });
  });

  it("completes the receipt and acknowledges its outbox in one transaction", () => {
    const store = createStore();
    const claim = store.claimConversationAdd(input());
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") return;

    expect(store.completeConversationAdd(claim.receipt.receiptId)?.status).toBe("completed");
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_outbox WHERE event_id = ?").get(claim.outboxEvent.eventId)).toEqual({ status: "acknowledged" });
  });

  it("safely reclaims a legacy processing receipt", () => {
    const store = createStore();
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_receipts (
        receipt_id, scope_hash, service_id, team_id, agent_id, user_id, session_id,
        idempotency_key, payload_digest, accepted_ids_json, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-receipt",
      createHash("sha256").update([
        ["service_id", scope.serviceId],
        ["team_id", scope.teamId],
        ["agent_id", scope.agentId],
        ["user_id", scope.userId],
        ["session_id", scope.sessionId],
        ["idempotency_key", scope.idempotencyKey],
      ].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("&")).digest("hex"),
      scope.serviceId,
      scope.teamId,
      scope.agentId,
      scope.userId,
      scope.sessionId,
      scope.idempotencyKey,
      "digest-1",
      "[]",
      "processing",
      1,
      1,
    );

    const claim = store.claimConversationAdd(input());

    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") return;
    expect(claim.receipt.receiptId).not.toBe("legacy-receipt");
    expect(store.readConversationAddReceipt(scope)).toMatchObject({
      receiptId: claim.receipt.receiptId,
      status: "pending",
    });
    expect(store.getRawDb().prepare("SELECT COUNT(*) AS count FROM conversation_add_receipts").get()).toEqual({ count: 1 });
  });
});
