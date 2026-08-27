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

function scopeHash(value: ConversationIdempotencyScope = scope): string {
  return createHash("sha256").update([
    ["service_id", value.serviceId],
    ["team_id", value.teamId],
    ["agent_id", value.agentId],
    ["user_id", value.userId],
    ["session_id", value.sessionId],
    ["idempotency_key", value.idempotencyKey],
  ].map(([name, field]) => `${name}=${encodeURIComponent(field)}`).join("&")).digest("hex");
}

function enableLegacyFtsResidues(store: VectorStore): void {
  // Newer Node SQLite builds may initialize the production FTS table during
  // VectorStore.init(); replace it with the legacy residue shape used here.
  store.getRawDb().exec("DROP TABLE IF EXISTS l0_fts");
  store.getRawDb().exec(`
    CREATE TABLE l0_fts (
      record_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL
    )
  `);
  // This runtime lacks FTS5. The recovery branch only needs the availability
  // flag to exercise its real SQL validation and deletion against a legacy
  // table shape.
  (store as unknown as { ftsAvailable: boolean }).ftsAvailable = true;
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
      scopeHash(),
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

  it("conflicts when a legacy processing receipt has a different digest", () => {
    const store = createStore();
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_receipts (
        receipt_id, scope_hash, service_id, team_id, agent_id, user_id, session_id,
        idempotency_key, payload_digest, accepted_ids_json, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-receipt",
      scopeHash(),
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

    expect(store.claimConversationAdd(input({ payloadDigest: "different-digest" }))).toEqual({ status: "conflict" });
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_receipts WHERE receipt_id = ?").get("legacy-receipt")).toEqual({ status: "processing" });
  });

  it("removes identifiable legacy processing L0, FTS, and outbox remnants before reclaiming", () => {
    const store = createStore();
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_receipts (
        receipt_id, scope_hash, service_id, team_id, agent_id, user_id, session_id,
        idempotency_key, payload_digest, accepted_ids_json, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-receipt",
      scopeHash(),
      scope.serviceId,
      scope.teamId,
      scope.agentId,
      scope.userId,
      scope.sessionId,
      scope.idempotencyKey,
      "digest-1",
      "[\"legacy-message\"]",
      "processing",
      1,
      1,
    );
    store.upsertL0({
      ...input().records[0],
      id: "legacy-message",
      messageText: "legacy partial message",
    }, undefined);
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_outbox (
        event_id, receipt_id, service_id, session_id, rounds, team_id, agent_id,
        status, created_at_ms, acknowledged_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
    `).run("legacy-outbox", "legacy-receipt", scope.serviceId, scope.sessionId, 2, scope.teamId, scope.agentId, 1);

    const claim = store.claimConversationAdd(input());

    expect(claim.status).toBe("claimed");
    expect(store.getRawDb().prepare("SELECT COUNT(*) AS count FROM l0_conversations WHERE record_id = 'legacy-message'").get()).toEqual({ count: 0 });
    if (store.isFtsAvailable()) {
      expect(store.getRawDb().prepare("SELECT COUNT(*) AS count FROM l0_fts WHERE record_id = 'legacy-message'").get()).toEqual({ count: 0 });
    }
    expect(store.getRawDb().prepare("SELECT COUNT(*) AS count FROM conversation_add_outbox WHERE event_id = 'legacy-outbox'").get()).toEqual({ count: 0 });
  });

  it("does not reclaim when an accepted ID has no canonical L0 metadata but its outbox remains", () => {
    const store = createStore();
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_receipts (
        receipt_id, scope_hash, service_id, team_id, agent_id, user_id, session_id,
        idempotency_key, payload_digest, accepted_ids_json, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-receipt", scopeHash(), scope.serviceId, scope.teamId, scope.agentId,
      scope.userId, scope.sessionId, scope.idempotencyKey, "digest-1",
      "[\"legacy-message\"]", "processing", 1, 1,
    );
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_outbox (
        event_id, receipt_id, service_id, session_id, rounds, team_id, agent_id,
        status, created_at_ms, acknowledged_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
    `).run("legacy-outbox", "legacy-receipt", scope.serviceId, scope.sessionId, 2, scope.teamId, scope.agentId, 1);

    expect(store.claimConversationAdd(input())).toEqual({ status: "unsupported" });
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_receipts WHERE receipt_id = 'legacy-receipt'").get()).toEqual({ status: "processing" });
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_outbox WHERE event_id = 'legacy-outbox'").get()).toEqual({ status: "pending" });
  });

  it("does not reclaim when a legacy outbox payload is outside the receipt scope", () => {
    const store = createStore();
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_receipts (
        receipt_id, scope_hash, service_id, team_id, agent_id, user_id, session_id,
        idempotency_key, payload_digest, accepted_ids_json, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-receipt", scopeHash(), scope.serviceId, scope.teamId, scope.agentId,
      scope.userId, scope.sessionId, scope.idempotencyKey, "digest-1",
      "[\"legacy-message\"]", "processing", 1, 1,
    );
    store.upsertL0({ ...input().records[0], id: "legacy-message" }, undefined);
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_outbox (
        event_id, receipt_id, service_id, session_id, rounds, team_id, agent_id,
        status, created_at_ms, acknowledged_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
    `).run("legacy-outbox", "legacy-receipt", "other-service", scope.sessionId, 2, scope.teamId, scope.agentId, 1);

    expect(store.claimConversationAdd(input())).toEqual({ status: "unsupported" });
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_receipts WHERE receipt_id = 'legacy-receipt'").get()).toEqual({ status: "processing" });
    expect(store.getRawDb().prepare("SELECT service_id FROM conversation_add_outbox WHERE event_id = 'legacy-outbox'").get()).toEqual({ service_id: "other-service" });
  });

  it("does not delete any FTS residue when one duplicate record ID has another scope", () => {
    const store = createStore();
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_receipts (
        receipt_id, scope_hash, service_id, team_id, agent_id, user_id, session_id,
        idempotency_key, payload_digest, accepted_ids_json, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-receipt", scopeHash(), scope.serviceId, scope.teamId, scope.agentId,
      scope.userId, scope.sessionId, scope.idempotencyKey, "digest-1",
      "[\"legacy-message\"]", "processing", 1, 1,
    );
    store.upsertL0({ ...input().records[0], id: "legacy-message" }, undefined);
    enableLegacyFtsResidues(store);
    const insertFts = store.getRawDb().prepare(`
      INSERT INTO l0_fts (record_id, session_key, session_id, team_id, user_id, agent_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertFts.run("legacy-message", scope.sessionId, scope.sessionId, scope.teamId, scope.userId, scope.agentId);
    insertFts.run("legacy-message", scope.sessionId, scope.sessionId, scope.teamId, "other-user", scope.agentId);

    expect(store.claimConversationAdd(input())).toEqual({ status: "unsupported" });
    expect(store.getRawDb().prepare("SELECT COUNT(*) AS count FROM l0_fts WHERE record_id = 'legacy-message'").get()).toEqual({ count: 2 });
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_receipts WHERE receipt_id = 'legacy-receipt'").get()).toEqual({ status: "processing" });
  });

  it("cleans all same-scope duplicate FTS residues before reclaiming", () => {
    const store = createStore();
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_receipts (
        receipt_id, scope_hash, service_id, team_id, agent_id, user_id, session_id,
        idempotency_key, payload_digest, accepted_ids_json, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-receipt", scopeHash(), scope.serviceId, scope.teamId, scope.agentId,
      scope.userId, scope.sessionId, scope.idempotencyKey, "digest-1",
      "[\"legacy-message\"]", "processing", 1, 1,
    );
    store.upsertL0({ ...input().records[0], id: "legacy-message" }, undefined);
    enableLegacyFtsResidues(store);
    const insertFts = store.getRawDb().prepare(`
      INSERT INTO l0_fts (record_id, session_key, session_id, team_id, user_id, agent_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertFts.run("legacy-message", scope.sessionId, scope.sessionId, scope.teamId, scope.userId, scope.agentId);
    insertFts.run("legacy-message", scope.sessionId, scope.sessionId, scope.teamId, scope.userId, scope.agentId);

    expect(store.claimConversationAdd(input({ records: [] })).status).toBe("claimed");
    expect(store.getRawDb().prepare("SELECT COUNT(*) AS count FROM l0_fts WHERE record_id = 'legacy-message'").get()).toEqual({ count: 0 });
  });

  it("does not reclaim a processing receipt when an accepted ID belongs to another isolation scope", () => {
    const store = createStore();
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_receipts (
        receipt_id, scope_hash, service_id, team_id, agent_id, user_id, session_id,
        idempotency_key, payload_digest, accepted_ids_json, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-receipt",
      scopeHash(),
      scope.serviceId,
      scope.teamId,
      scope.agentId,
      scope.userId,
      scope.sessionId,
      scope.idempotencyKey,
      "digest-1",
      "[\"legacy-message\"]",
      "processing",
      1,
      1,
    );
    store.upsertL0({
      ...input().records[0],
      id: "legacy-message",
      userId: "other-user",
    }, undefined);

    expect(store.claimConversationAdd(input())).toEqual({ status: "unsupported" });
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_receipts WHERE receipt_id = 'legacy-receipt'").get()).toEqual({ status: "processing" });
    expect(store.getRawDb().prepare("SELECT user_id FROM l0_conversations WHERE record_id = 'legacy-message'").get()).toEqual({ user_id: "other-user" });
  });

  it("does not reclaim a processing receipt when an unavailable vector residue cannot be cleaned", () => {
    const store = createStore();
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_receipts (
        receipt_id, scope_hash, service_id, team_id, agent_id, user_id, session_id,
        idempotency_key, payload_digest, accepted_ids_json, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-receipt",
      scopeHash(),
      scope.serviceId,
      scope.teamId,
      scope.agentId,
      scope.userId,
      scope.sessionId,
      scope.idempotencyKey,
      "digest-1",
      "[\"legacy-message\"]",
      "processing",
      1,
      1,
    );
    // dimensions=0 deliberately has no vec0 handle; this table models an
    // old vector residue that this store instance cannot clean safely.
    store.getRawDb().exec("CREATE TABLE l0_vec (record_id TEXT PRIMARY KEY)");
    store.getRawDb().prepare("INSERT INTO l0_vec (record_id) VALUES (?)").run("legacy-message");

    expect(store.claimConversationAdd(input())).toEqual({ status: "unsupported" });
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_receipts WHERE receipt_id = 'legacy-receipt'").get()).toEqual({ status: "processing" });
    expect(store.getRawDb().prepare("SELECT COUNT(*) AS count FROM l0_vec WHERE record_id = 'legacy-message'").get()).toEqual({ count: 1 });
  });

  it("refuses to acknowledge an outbox attached to a processing receipt", () => {
    const store = createStore();
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_receipts (
        receipt_id, scope_hash, service_id, team_id, agent_id, user_id, session_id,
        idempotency_key, payload_digest, accepted_ids_json, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-receipt",
      scopeHash(),
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
    store.getRawDb().prepare(`
      INSERT INTO conversation_add_outbox (
        event_id, receipt_id, service_id, session_id, rounds, team_id, agent_id,
        status, created_at_ms, acknowledged_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
    `).run("legacy-outbox", "legacy-receipt", scope.serviceId, scope.sessionId, 2, scope.teamId, scope.agentId, 1);

    expect(store.ackConversationOutbox("legacy-outbox")).toBe(false);
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_receipts WHERE receipt_id = 'legacy-receipt'").get()).toEqual({ status: "processing" });
    expect(store.getRawDb().prepare("SELECT status FROM conversation_add_outbox WHERE event_id = 'legacy-outbox'").get()).toEqual({ status: "pending" });
  });
});
