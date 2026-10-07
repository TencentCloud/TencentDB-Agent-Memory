import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorStore } from "./sqlite/memory-store.js";
import { __setMemoryReviewEnabledForTests } from "./visibility.js";
import { resolveReviewRows, setReviewStatus, ReviewConflictError, reviewEventId } from "./review.js";
import { acknowledgeDerivedReview, derivedProfileAllowed, inspectDerivedReview, profileReviewFence } from "./derived-review.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import type { IMemoryStore, MemoryEvent } from "./types.js";
import { StorageAdapter, scopeProfileStorageView } from "../storage/adapter.js";
import { createLocalStorageBackend } from "../storage/factory.js";
import { appendLedgerEvent, redactLedgerEvents, replayLedgerEvents } from "../record/event-ledger.js";
import { revertMemory } from "../record/memory-revert.js";
import { clearChatMemoryContentResilient } from "../../gateway/chat-memory-handlers.js";
import { migrateReviewLedger, runMigrationCli, type MigrationTargetStore } from "../../../scripts/migrate-sqlite-to-tcvdb/sqlite-to-tcvdb.js";

const ISO = { teamId: "t1", userId: "u1", agentId: "a1" };
const op = (id: string) => `rop-${createHash("sha256").update(id).digest("hex")}`;
const record = (id: string, sources: string[] = []): MemoryRecord => ({
  id, content: `fact ${id}`, type: "work_fact", priority: 50, scene_name: "default", source_message_ids: [],
  metadata: {}, timestamps: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  sessionKey: "sk", sessionId: "ses", ...ISO, review_sources: sources,
});

describe("committed observed-retraction review protocol", () => {
  let dir: string;
  let store: VectorStore;
  let storage: StorageAdapter;

  beforeEach(() => {
    __setMemoryReviewEnabledForTests(true);
    dir = mkdtempSync(path.join(tmpdir(), "review-protocol-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    store.upsertL1(record("root"), undefined);
    storage = new StorageAdapter(createLocalStorageBackend(path.join(dir, "data")));
  });

  afterEach(() => {
    store.close();
    __setMemoryReviewEnabledForTests(undefined);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const all = () => store.queryL1Records({ ...ISO, visibility: "all" });
  const state = (id = "root") => all().find((r) => r.record_id === id)?.review_status;

  it("commit failure changes no materialized state and emits no phantom review", () => {
    vi.spyOn(store, "appendMemoryEvent").mockImplementationOnce(() => { throw new Error("write failed"); });
    expect(() => store.setL1ReviewStatus("root", "quarantined", ISO)).toThrow("write failed");
    expect(state()).toBe("active");
    expect(store.queryMemoryEvents({ record_id: "root" })).toEqual([]);
  });

  it("foreign legacy empty owner fields stay inside the explicit default bucket", () => {
    const defaults = { teamId: "default", userId: "default", agentId: "default" };
    store.upsertL1({ ...record("legacy-default"), teamId: undefined, userId: undefined, agentId: undefined }, undefined);
    store.getRawDb().prepare("UPDATE l1_records SET team_id='', user_id='', agent_id='' WHERE record_id=?").run("legacy-default");
    expect(store.queryL1Records(defaults).map((r) => r.record_id)).toEqual(["legacy-default"]);
    expect(store.countL1({ ...defaults, visibility: "all" })).toBe(1);
    expect(store.queryL1Paginated({ ...defaults, visibility: "all", limit: 50, offset: 0 }).total).toBe(1);
    store.setL1ReviewStatus("legacy-default", "quarantined", defaults);
    expect(store.queryL1Records(defaults)).toEqual([]);
    expect(store.queryL1Records(ISO).map((r) => r.record_id)).toEqual(["root"]);
  });

  it("a committed review survives restart without an outbox or status-column write", () => {
    store.setL1ReviewStatus("root", "quarantined", ISO, { operation_id: op("retry"), reason: "incorrect" });
    expect(store.queryL1Records({ ...ISO }, { review: false })[0]?.review_status).toBe("active");
    store.close();
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    expect(state()).toBe("quarantined");
    const retry = store.setL1ReviewStatus("root", "quarantined", ISO, { operation_id: op("retry"), reason: "incorrect" });
    expect(retry?.changed).toBe(true);
    expect(store.queryMemoryEvents({ record_id: "root", op: "retracted" })).toHaveLength(1);
  });

  it("a timeout after server commit is recoverable with the original logical identity", () => {
    const append = store.appendMemoryEvent.bind(store);
    vi.spyOn(store, "appendMemoryEvent").mockImplementationOnce((e) => { append(e); throw new Error("response lost"); });
    expect(() => store.setL1ReviewStatus("root", "quarantined", ISO, { operation_id: op("lost") })).toThrow("response lost");
    expect(state()).toBe("quarantined");
    expect(store.setL1ReviewStatus("root", "quarantined", ISO, { operation_id: op("lost") })?.event).toBeDefined();
    expect(store.queryMemoryEvents({ record_id: "root", op: "retracted" })).toHaveLength(1);
  });

  it("reusing an identity with another action or reason is rejected", () => {
    store.setL1ReviewStatus("root", "quarantined", ISO, { operation_id: op("same"), reason: "first" });
    expect(() => store.setL1ReviewStatus("root", "active", ISO, { operation_id: op("same"), reason: "first" })).toThrow(ReviewConflictError);
    expect(() => store.setL1ReviewStatus("root", "quarantined", ISO, { operation_id: op("same"), reason: "second" })).toThrow(ReviewConflictError);
    expect(state()).toBe("quarantined");
  });

  it("retired protocol payloads and unreceipted review commands are rejected", () => {
    const event = store.setL1ReviewStatus("root", "quarantined", ISO)!.event!;
    expect(() => store.appendMemoryEvent({ ...event, review: { ...event.review, protocol: 1 } } as unknown as MemoryEvent)).toThrow("Invalid review protocol payload");
    expect(() => store.appendMemoryEvent({ ...event, review: undefined })).toThrow("identity");
    expect(store.queryMemoryEvents({ source: "review" })).toHaveLength(1);
  });

  it("an explicit no-op receipt remains a no-op after a later review", () => {
    store.setL1ReviewStatus("root", "active", ISO, { operation_id: op("noop") });
    store.setL1ReviewStatus("root", "quarantined", ISO);
    expect(store.setL1ReviewStatus("root", "active", ISO, { operation_id: op("noop") })?.changed).toBe(false);
    expect(state()).toBe("quarantined");
  });

  it("one restore identity has one immutable outcome across in-flight duplicate deliveries", async () => {
    store.setL1ReviewStatus("root", "quarantined", ISO);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstReady!: () => void;
    let secondReady!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    const secondGate = new Promise<void>((r) => { releaseSecond = r; });
    const prepared = new Promise<void>((r) => { firstReady = r; });
    const lookedUp = new Promise<void>((r) => { secondReady = r; });
    const first = {
      queryMemoryEvents: store.queryMemoryEvents.bind(store),
      queryL1Records: store.queryL1Records.bind(store),
      appendMemoryEvent: async (event: MemoryEvent) => { firstReady(); await firstGate; store.appendMemoryEvent(event); },
      commitMemoryEvent: async (event: MemoryEvent) => { firstReady(); await firstGate; return store.commitMemoryEvent(event); },
    } as unknown as IMemoryStore;
    const second = {
      queryMemoryEvents: store.queryMemoryEvents.bind(store),
      queryL1Records: async (...args: Parameters<IMemoryStore["queryL1Records"]>) => { secondReady(); await secondGate; return store.queryL1Records(...args); },
      appendMemoryEvent: store.appendMemoryEvent.bind(store),
      commitMemoryEvent: (event: MemoryEvent) => store.commitMemoryEvent(event),
    } as unknown as IMemoryStore;
    const operation = { operation_id: op("in-flight-restore") };
    try {
      const a = setReviewStatus(first, "root", "active", ISO, operation);
      await prepared;
      const b = setReviewStatus(second, "root", "active", ISO, operation);
      await lookedUp;
      releaseFirst();
      const committed = await a;
      expect(state()).toBe("active");
      releaseSecond();
      expect(await b).toEqual(committed);
      expect(state()).toBe("active");
      expect(store.queryMemoryEvents({ record_id: "root", op: "restored" })).toHaveLength(1);
    } finally { releaseFirst(); releaseSecond(); }
  });

  it("a new retract command adds a token even while an observed restore is waiting", async () => {
    store.setL1ReviewStatus("root", "quarantined", ISO);
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const prepared = new Promise<void>((r) => { ready = r; });
    const writer = {
      queryMemoryEvents: store.queryMemoryEvents.bind(store),
      queryL1Records: store.queryL1Records.bind(store),
      appendMemoryEvent: async (event: MemoryEvent) => { ready(); await gate; store.appendMemoryEvent(event); },
      commitMemoryEvent: async (event: MemoryEvent) => { ready(); await gate; return store.commitMemoryEvent(event); },
    } as unknown as IMemoryStore;
    try {
      const restoring = setReviewStatus(writer, "root", "active", ISO, { operation_id: op("observed-restore") });
      await prepared;
      const retracted = store.setL1ReviewStatus("root", "quarantined", ISO, { operation_id: op("new-retraction") });
      release();
      await restoring;
      expect(retracted?.changed).toBe(true);
      expect(state()).toBe("quarantined");
      expect(all()[0]?.review_tokens).toEqual([op("new-retraction")]);
    } finally { release(); }
  });

  it("restore only cancels observed tokens, regardless of clock ordering", () => {
    const first = store.setL1ReviewStatus("root", "quarantined", ISO)!.event!;
    const restore: MemoryEvent = { ...first, event_ts: "2001-01-01T00:00:00.000Z", op: "restored", review: { ...first.review!, operation_id: op("clock-restore"), previous_status: "quarantined", observed: [first.review!.operation_id!] } };
    const second: MemoryEvent = { ...first, event_ts: "2000-01-01T00:00:00.000Z", review: { ...first.review!, operation_id: op("clock-retract") } };
    restore.event_id = reviewEventId(restore);
    second.event_id = reviewEventId(second);
    store.appendMemoryEvent(second);
    store.appendMemoryEvent(restore);
    expect(state()).toBe("quarantined");
    expect(all()[0]?.review_tokens).toEqual([second.review!.operation_id]);
  });

  it("duplicate physical deliveries use one logical token and delayed delivery cannot undo restore", () => {
    const first = store.setL1ReviewStatus("root", "quarantined", ISO, { operation_id: op("logical") })!.event!;
    store.setL1ReviewStatus("root", "active", ISO);
    expect(() => store.appendMemoryEvent({ ...first, event_id: "evt-" + "4".repeat(32) })).toThrow("identity");
    store.appendMemoryEvent({ ...first, event_ts: "2099-01-01T00:00:00.000Z" });
    expect(state()).toBe("active");
  });

  it("concurrent deliveries of one restore identity cannot widen its observed cancellation", () => {
    const first = store.setL1ReviewStatus("root", "quarantined", ISO)!.event!;
    const restore = store.setL1ReviewStatus("root", "active", ISO, { operation_id: op("same-restore") })!.event!;
    const second = store.setL1ReviewStatus("root", "quarantined", ISO)!.event!;
    expect(store.commitMemoryEvent({ ...restore, review: { ...restore.review!, observed: [first.review!.operation_id!, second.review!.operation_id!] } })).toEqual(restore);
    expect(state()).toBe("quarantined");
    expect(all()[0]?.review_tokens).toEqual([second.review!.operation_id]);
  });

  it("a no-op delivery cannot acquire future cancellation through a duplicate restore", () => {
    const receipt = store.setL1ReviewStatus("root", "active", ISO, { operation_id: op("same-noop") })!.event!;
    const retract = store.setL1ReviewStatus("root", "quarantined", ISO)!.event!;
    expect(store.commitMemoryEvent({ ...receipt, review: { ...receipt.review!, no_op: false, observed: [retract.review!.operation_id!] } })).toEqual(receipt);
    expect(state()).toBe("quarantined");
  });

  it("conflicting concurrent commits are rejected without adding conflict facts", () => {
    const first = store.setL1ReviewStatus("root", "quarantined", ISO, { operation_id: op("collision") })!.event!;
    expect(() => store.commitMemoryEvent({ ...first, op: "restored", review: { ...first.review!, request_hash: "b".repeat(64), observed: [op("collision")] } })).toThrow(ReviewConflictError);
    expect(state()).toBe("quarantined");
    expect(store.queryMemoryEvents({ record_id: "root" })).toHaveLength(1);
    store.setL1ReviewStatus("root", "active", ISO, { operation_id: op("resolved") });
    expect(state()).toBe("active");
  });

  it("a retraction committed after merge propagates through a deleted source", () => {
    store.appendMemoryEvent({ event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses", team_id: "t1", user_id: "u1", agent_id: "a1", record_id: "root", content: "original", op: "created", source: "extraction" });
    store.upsertL1(record("child", ["root"]), undefined);
    store.deleteL1("root", ISO);
    store.setL1ReviewStatus("root", "quarantined", ISO);
    expect(state("child")).toBe("quarantined");
    expect(store.queryL1Records(ISO)).toEqual([]);
    store.setL1ReviewStatus("root", "active", ISO);
    expect(state("child")).toBe("active");
    expect(all().some((r) => r.record_id === "root")).toBe(false);
  });

  it("lineage cycles converge and missing lineage is suppressed rather than assumed clean", () => {
    store.upsertL1(record("a", ["b"]), undefined);
    store.upsertL1(record("b", ["a"]), undefined);
    store.setL1ReviewStatus("a", "quarantined", ISO);
    expect(state("b")).toBe("quarantined");
    store.upsertL1(record("orphan", ["missing"]), undefined);
    expect(state("orphan")).toBe("quarantined");
    expect(all().find((r) => r.record_id === "orphan")?.review_incomplete).toBe(true);
    store.setL1ReviewStatus("orphan", "active", ISO);
    expect(all().find((r) => r.record_id === "orphan")?.review_incomplete).toBe(true);
  });

  it("clear invalidates a late generation on read and cannot be undone by restore", () => {
    expect(store.upsertL1({ ...record("late"), review_guard_at: "2026-01-01T10:00:00.000Z" }, undefined)).toBe(true);
    expect(store.upsertL1({ ...record("unknown-age"), createdAt: "", updatedAt: "" }, undefined)).toBe(true);
    store.appendMemoryEvent({ event_ts: "2026-01-01T11:00:00.000Z", session_key: "", session_id: "", team_id: "t1", agent_id: "a1", record_id: "agent-clear", op: "deleted", source: "api_mutation", scope: "agent", content: "" });
    expect(state("late")).toBe("quarantined");
    expect(state("unknown-age")).toBe("quarantined");
    expect(() => store.setL1ReviewStatus("late", "active", ISO)).toThrow(/invalidated|restored/);
    expect(store.upsertL1({ ...record("refused"), review_guard_at: "2026-01-01T10:00:00.000Z" }, undefined)).toBe(false);
    expect(all().some((r) => r.record_id === "refused")).toBe(false);
  });

  it("clear fences a pre-clear generation even when its writer clock is far ahead", async () => {
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    await clearChatMemoryContentResilient({ store, storage, ...ISO, logger });
    const late = { ...record("fast-clock"), createdAt: "2099-01-01T00:00:00.000Z", updatedAt: "2099-01-01T00:00:00.000Z", review_guard_at: "2099-01-01T00:00:00.000Z", review_epoch: 0 } as MemoryRecord;
    expect(store.upsertL1(late, undefined)).toBe(false);
    expect(store.queryL1Records({ ...ISO, recordIds: ["fast-clock"] })).toEqual([]);
  });

  it("clear receipt retry does not advance its epoch and fresh generations remain usable", () => {
    const event: MemoryEvent = { event_id: "evt-" + "b".repeat(32), event_ts: "2000-01-01T00:00:00.000Z", session_key: "", session_id: "", team_id: "t1", agent_id: "a1", record_id: "clear", content: "", op: "deleted", source: "api_mutation", scope: "agent", layer: "l1" };
    const first = store.commitClearFence(event);
    expect(first.review?.guard_epoch).toBe(1);
    expect(store.commitClearFence(event)).toEqual(first);
    expect(store.getClearEpoch(ISO)).toBe(1);
    expect(store.upsertL1({ ...record("fresh"), review_epoch: 1 }, undefined)).toBe(true);
    expect(store.queryL1Records(ISO).map((r) => r.record_id)).toEqual(["fresh"]);
    expect(store.upsertL1({ ...record("root"), review_epoch: 1 }, undefined)).toBe(false);
    store.close();
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    expect(store.getClearEpoch(ISO)).toBe(1);
    expect(store.queryL1Records(ISO).map((r) => r.record_id)).toEqual(["fresh"]);
  });

  it("an expected-existing update cannot recreate a concurrently removed row", () => {
    expect(store.upsertL1({ ...record("gone"), expected_existing: true }, undefined)).toBe(false);
    expect(all().some((r) => r.record_id === "gone")).toBe(false);
  });

  it("a stale cross-instance restore cannot cancel a retraction committed while it waits", async () => {
    const initial = store.setL1ReviewStatus("root", "quarantined", ISO)!.event!;
    const peer = new VectorStore(path.join(dir, "vectors.db"), 0);
    peer.init();
    let ready!: () => void;
    let release!: () => void;
    const observed = new Promise<void>((r) => { ready = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const commit = store.commitMemoryEvent.bind(store);
    vi.spyOn(store, "commitMemoryEvent").mockImplementationOnce(async (event) => { ready(); await gate; return commit(event); });
    try {
      const restoring = setReviewStatus(store, "root", "active", ISO);
      await observed;
      const concurrent = { ...initial, event_ts: "2000-01-01T00:00:00.000Z", review: { ...initial.review!, operation_id: op("peer-retract") } };
      concurrent.event_id = reviewEventId(concurrent);
      peer.appendMemoryEvent(concurrent);
      release();
      await restoring;
      expect(state()).toBe("quarantined");
      expect(all()[0]?.review_tokens).toEqual([concurrent.review.operation_id]);
    } finally { release(); peer.close(); }
  });

  it("clear commits its durable fence before physical deletion and stops if commit fails", async () => {
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    const physical = store.clearMemoryContent.bind(store);
    const clear = vi.spyOn(store, "clearMemoryContent");
    vi.spyOn(store, "appendMemoryEvent").mockImplementationOnce(() => { throw new Error("durable fence failed"); });
    await expect(clearChatMemoryContentResilient({ store, storage, ...ISO, logger })).rejects.toThrow("durable fence failed");
    expect(clear).not.toHaveBeenCalled();
    expect(state()).toBe("active");
    clear.mockImplementation((filter) => {
      expect(store.queryMemoryEvents({ scope: "agent", layer: "l1", op: "deleted" })).toHaveLength(1);
      expect(store.queryL1Records(ISO)).toEqual([]);
      return physical(filter);
    });
    await clearChatMemoryContentResilient({ store, storage, ...ISO, logger });
    expect(all()).toEqual([]);
  });

  it("clear racing a generation commit suppresses the late row even after restart", () => {
    const guard = new Date(Date.now() - 1000).toISOString();
    const check = store.queryMemoryEvents.bind(store);
    vi.spyOn(store, "queryMemoryEvents").mockImplementationOnce((filter) => {
      const before = check(filter);
      store.appendMemoryEvent({ event_ts: new Date().toISOString(), session_key: "", session_id: "", team_id: "t1", agent_id: "a1", record_id: "clear", content: "", op: "deleted", scope: "agent", layer: "l1", source: "api_mutation" });
      return before;
    });
    expect(store.upsertL1({ ...record("late"), review_guard_at: guard }, undefined)).toBe(true);
    store.close();
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    expect(store.queryL1Records({ ...ISO, recordIds: ["late"] })).toEqual([]);
    expect(all().find((r) => r.record_id === "late")?.review_tokens?.[0]).toMatch(/^clear:/);
  });

  it("migration preserves raw legacy state and all review facts, including deleted ancestors", async () => {
    store.appendMemoryEvent({ event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses", team_id: "t1", user_id: "u1", agent_id: "a1", record_id: "root", content: "original", op: "created", source: "extraction" });
    store.upsertL1(record("child", ["root"]), undefined);
    store.setL1ReviewStatus("root", "quarantined", ISO, { operation_id: op("migration") });
    store.deleteL1("root", ISO);
    const target = new VectorStore(path.join(dir, "migrated.db"), 0);
    target.init();
    try {
      const raw = store.queryL1RecordsCursor("", 50, { review: false });
      for (const row of raw) target.upsertL1({ ...record(row.record_id, JSON.parse(row.review_sources_json ?? "[]") as string[]), review_status: row.review_status }, undefined);
      expect(await migrateReviewLedger(store, target)).toBe(2);
      expect(target.queryL1Records(ISO)).toEqual([]);
      target.setL1ReviewStatus("root", "active", ISO);
      expect(target.queryL1Records(ISO).map((r) => r.record_id)).toEqual(["child"]);
      await expect(migrateReviewLedger(store, { ...target, appendMemoryEvent: undefined } as never)).rejects.toThrow("preserve and verify the review ledger");
    } finally { target.close(); }
  });

  it("migration refuses a target that silently keeps different ledger bytes", async () => {
    store.setL1ReviewStatus("root", "quarantined", ISO, { operation_id: op("migration-verification") });
    const target = new VectorStore(path.join(dir, "bad-ledger-target.db"), 0);
    target.init();
    const append = target.appendMemoryEvent.bind(target);
    vi.spyOn(target, "appendMemoryEvent").mockImplementation((event) => append({ ...event, content: "different bytes" }));
    try { await expect(migrateReviewLedger(store, target)).rejects.toThrow("Ledger verification failed"); }
    finally { target.close(); }
  });

  it("migration rejects missing event identity instead of inventing historical control tokens", async () => {
    store.setL1ReviewStatus("root", "quarantined", ISO);
    store.getRawDb().prepare("UPDATE memory_events SET event_id='' WHERE record_id=?").run("root");
    const target = new VectorStore(path.join(dir, "invalid-ledger-target.db"), 0);
    target.init();
    try {
      await expect(migrateReviewLedger(store, target)).rejects.toThrow("Ledger event has no valid identity");
      expect(target.queryMemoryEvents({})).toEqual([]);
    } finally { target.close(); }
  });

  it("the actual migration CLI verifies physical counts and keeps ancestor review controls", async () => {
    store.upsertL1(record("child", ["root"]), undefined);
    store.setL1ReviewStatus("root", "quarantined", ISO);
    store.deleteL1("root", ISO);
    const destinationPath = path.join(dir, "cli-target.db");
    writeFileSync(path.join(dir, "unused-config.json"), "{}");
    const createTargetStore = (): MigrationTargetStore => {
      const destination = new VectorStore(destinationPath, 0);
      return {
        init: () => destination.init(), close: () => destination.close(), isDegraded: () => destination.isDegraded(),
        countL0: () => destination.countL0(), countL1: (filter) => destination.countL1(filter),
        upsertL0: destination.upsertL0.bind(destination), upsertL1: destination.upsertL1.bind(destination),
        appendMemoryEvent: destination.appendMemoryEvent.bind(destination),
        commitMemoryEvent: destination.commitMemoryEvent.bind(destination),
        queryMemoryEvents: destination.queryMemoryEvents.bind(destination),
      };
    };
    const summary = await runMigrationCli([
      "--plugin-data-dir", dir, "--sqlite-path", path.join(dir, "vectors.db"),
      "--openclaw-config-path", path.join(dir, "unused-config.json"),
      "--tcvdb-url", "http://fixture", "--tcvdb-username", "fixture", "--tcvdb-api-key", "fixture",
      "--tcvdb-database", "fixture", "--tcvdb-embedding-model", "none",
      "--no-apply-config", "--no-rewrite-manifest", "--yes",
    ], { createTargetStore, verifyDelayMs: 0 });
    expect(summary.migration).toMatchObject({ l1Migrated: 1, eventsMigrated: 1, targetL1Count: 1, configWritten: false });
    const reopened = new VectorStore(destinationPath, 0);
    reopened.init();
    try {
      expect(reopened.queryL1Records(ISO)).toEqual([]);
      reopened.setL1ReviewStatus("root", "active", ISO);
      expect(reopened.queryL1Records(ISO).map((r) => r.record_id)).toEqual(["child"]);
    } finally { reopened.close(); }
  });

  it.each(["ledger-only", "unverifiable", "non-atomic"] as const)("migration rejects a %s target before importing content or ledger", async (mode) => {
    const destination = new VectorStore(path.join(dir, "refused-target.db"), 0);
    const initialized = destination.init();
    writeFileSync(path.join(dir, "unused-config.json"), "{}");
    if (mode === "ledger-only") destination.appendMemoryEvent({ event_ts: "2026-01-01T00:00:00.000Z", session_key: "", session_id: "", team_id: "t1", agent_id: "a1", record_id: "old-clear", content: "", op: "deleted", source: "api_mutation", scope: "agent", layer: "l1" });
    if (mode === "non-atomic") store.setL1ReviewStatus("root", "quarantined", ISO);
    const append = vi.spyOn(destination, "appendMemoryEvent");
    const upsert = vi.spyOn(destination, "upsertL1");
    const target: MigrationTargetStore = {
      init: () => initialized, close: () => destination.close(), isDegraded: () => destination.isDegraded(),
      countL0: () => destination.countL0(), countL1: (filter) => destination.countL1(filter),
      upsertL0: destination.upsertL0.bind(destination), upsertL1: destination.upsertL1.bind(destination),
      appendMemoryEvent: destination.appendMemoryEvent.bind(destination),
      commitMemoryEvent: mode === "non-atomic" ? undefined : destination.commitMemoryEvent.bind(destination),
      queryMemoryEvents: mode === "unverifiable" ? undefined : destination.queryMemoryEvents.bind(destination),
    };
    try {
      await expect(runMigrationCli([
        "--plugin-data-dir", dir, "--sqlite-path", path.join(dir, "vectors.db"),
        "--openclaw-config-path", path.join(dir, "unused-config.json"),
        "--tcvdb-url", "http://fixture", "--tcvdb-username", "fixture", "--tcvdb-api-key", "fixture",
        "--tcvdb-database", "fixture", "--tcvdb-embedding-model", "none",
        "--no-apply-config", "--no-rewrite-manifest", "--yes",
      ], { createTargetStore: () => target, verifyDelayMs: 0 })).rejects.toThrow(mode === "ledger-only" ? "not empty" : mode === "unverifiable" ? "cannot verify" : "atomic immutable ledger");
      expect(append).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    } finally { destination.close(); }
  });

  it("process exit inside a database workflow cannot commit a partial physical mutation", () => {
    const dbPath = path.join(dir, "vectors.db");
    store.close();
    const storeModule = new URL("./sqlite/memory-store.ts", import.meta.url).href;
    const script = `import { VectorStore } from ${JSON.stringify(storeModule)};
      const store = new VectorStore(process.argv[1], 0); store.init();
      store.executeMemoryTransaction(function* () {
        yield store.deleteL1("root", { teamId: "t1", userId: "u1", agentId: "a1" });
        process.exit(17);
      });`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dbPath], { cwd: process.cwd(), encoding: "utf8" });
    store = new VectorStore(dbPath, 0);
    store.init();
    expect(child.status).toBe(17);
    expect(store.queryL1Records(ISO).map((row) => row.record_id)).toEqual(["root"]);
  });

  it("physical revert rolls back rows and receipt together, then retries after reopening the database", async () => {
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    const snapshot = JSON.stringify(all()[0]);
    store.upsertL1(record("successor", ["root"]), undefined);
    store.deleteL1("root", ISO);
    const base = { event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses", team_id: "t1", user_id: "u1", agent_id: "a1", source: "extraction" as const, layer: "l1" as const };
    store.appendMemoryEvent({ ...base, record_id: "root", op: "superseded", superseded_by: "successor", snapshot_json: snapshot, content: "fact root" });
    store.appendMemoryEvent({ ...base, record_id: "successor", op: "updated", supersedes: ["root"], content: "fact successor" });
    vi.spyOn(store, "appendMemoryEvent").mockImplementationOnce(() => { throw new Error("receipt commit interrupted"); });
    const options = { operationId: "atomic-revert" };
    const failed = await revertMemory({ store, recordId: "successor", options, isolation: ISO, logger });
    expect(failed).toMatchObject({ ok: false });
    expect(all().map((r) => r.record_id)).toEqual(["successor"]);
    expect(store.queryMemoryEvents({ op: "reverted" })).toEqual([]);
    store.close();
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    const committed = await revertMemory({ store, recordId: "successor", options, isolation: ISO, logger });
    expect(committed).toMatchObject({ ok: true, restored: ["root"] });
    expect(all().map((r) => r.record_id)).toEqual(["root"]);
    expect(await revertMemory({ store, recordId: "successor", options, isolation: ISO, logger })).toEqual(committed);
    expect(store.queryMemoryEvents({ op: "reverted" })).toHaveLength(1);
  });

  it("a lost revert COMMIT response without a visible receipt remains commit_unknown", async () => {
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    store.appendMemoryEvent({ event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses", team_id: "t1", user_id: "u1", agent_id: "a1", record_id: "root", content: "fact root", op: "created", source: "extraction", layer: "l1" });
    const execute = store.executeMemoryTransaction.bind(store);
    const query = store.queryMemoryEvents.bind(store);
    let hideReceipt = false;
    vi.spyOn(store, "queryMemoryEvents").mockImplementation((filter, options) => {
      if (hideReceipt && filter.operation_id) { hideReceipt = false; return []; }
      return query(filter, options);
    });
    vi.spyOn(store, "executeMemoryTransaction").mockImplementationOnce((program) => {
      execute(program);
      hideReceipt = true;
      throw new Error("lost COMMIT response");
    });
    const params = { store, recordId: "root", options: { operationId: "lost-revert-commit" }, isolation: ISO, logger };
    expect(await revertMemory(params)).toMatchObject({ ok: false, status: 503, commit_unknown: true, operation_id: "lost-revert-commit" });
    expect(await revertMemory(params)).toMatchObject({ ok: true, operation_id: "lost-revert-commit" });
    expect(store.queryMemoryEvents({ record_id: "root", op: "reverted" })).toHaveLength(1);
    expect(all()).toEqual([]);
  });

  it("revert embedding planning query failure reports an identified failure before mutation", async () => {
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    const embedding = { embed: vi.fn() };
    vi.spyOn(store, "queryMemoryEvents").mockImplementationOnce(() => { throw new Error("backend unavailable"); });
    const result = await revertMemory({ store, recordId: "root", options: { operationId: "embedding-plan-failure" }, isolation: ISO, logger, embedding: embedding as never });
    expect(result).toMatchObject({ ok: false, status: 503, operation_id: "embedding-plan-failure" });
    expect(embedding.embed).not.toHaveBeenCalled();
    expect(all().map((r) => r.record_id)).toEqual(["root"]);
    expect(store.queryMemoryEvents({ op: "reverted" })).toEqual([]);
  });

  it("complete history is loaded once per graph batch rather than once per audit page", () => {
    for (let i = 0; i < 1201; i++) store.appendMemoryEvent({ event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses", team_id: "t1", user_id: "u1", agent_id: "a1", record_id: "root", content: "", op: "created", source: "extraction", layer: "l1" });
    store.setL1ReviewStatus("root", "quarantined", ISO);
    const query = vi.spyOn(store, "queryMemoryEvents");
    expect(state()).toBe("quarantined");
    expect(query.mock.calls.filter(([filter, options]) => options?.complete && filter.record_ids?.includes("root"))).toHaveLength(1);
    expect(store.queryMemoryEvents({ record_id: "root", limit: 1000 })).toHaveLength(1000);
    expect(store.queryMemoryEvents({ record_id: "root" }, { complete: true })).toHaveLength(1202);
  });

  it("derived acknowledgement keeps one receipt under concurrent delivery and retry after changed bytes", async () => {
    store.setL1ReviewStatus("root", "quarantined", ISO);
    const content = "verified derived bytes";
    const inspected = await inspectDerivedReview(store, "persona.md", content, ISO);
    const operation = { operation_id: "derived-receipt", reason: "verified" };
    const receipts = await Promise.all(Array.from({ length: 8 }, () => acknowledgeDerivedReview(store, "persona.md", content, inspected, ISO, operation)));
    for (const receipt of receipts) expect(receipt).toEqual(receipts[0]);
    expect(store.queryMemoryEvents({ layer: "l3", source: "review" })).toHaveLength(1);
    expect(await acknowledgeDerivedReview(store, "persona.md", "different bytes", inspected, ISO, operation)).toEqual(receipts[0]);
    expect((await inspectDerivedReview(store, "persona.md", "different bytes", ISO)).blocked).toBe(true);
    await expect(acknowledgeDerivedReview(store, "persona.md", content, inspected, ISO, { ...operation, reason: "different reason" })).rejects.toThrow(ReviewConflictError);
  });

  it("async and sync resolvers produce the same state", async () => {
    store.setL1ReviewStatus("root", "quarantined", ISO);
    const raw = store.queryL1Records({ ...ISO, visibility: "all" }, { review: false });
    expect(await resolveReviewRows(store, raw)).toEqual(all());
  });

  it("outbox replay changes effective visibility without a second status projection", async () => {
    const first = store.setL1ReviewStatus("root", "quarantined", ISO)!.event!;
    await appendLedgerEvent({ store, storage, event: first, storeAlreadyCommitted: true });
    const other = new VectorStore(path.join(dir, "other.db"), 0);
    other.init();
    try {
      other.upsertL1(record("root"), undefined);
      const result = await replayLedgerEvents({ store: other, storage });
      expect(result.failed).toBe(0);
      expect(other.queryL1Records(ISO)).toEqual([]);
      await replayLedgerEvents({ store: other, storage });
      expect(other.queryMemoryEvents({ record_id: "root" })).toHaveLength(1);
    } finally { other.close(); }
  });

  it("redaction removes reason from both durable legs but preserves review identity", async () => {
    const first = store.setL1ReviewStatus("root", "quarantined", ISO, { reason: "private-review-reason" })!.event!;
    await appendLedgerEvent({ store, storage, event: first, storeAlreadyCommitted: true });
    await redactLedgerEvents({ store, storage, filter: { team_id: "t1", agent_id: "a1", until: "2099-01-01T00:00:00.000Z" } });
    expect(store.queryMemoryEvents({ record_id: "root" })[0]?.reason).toBeUndefined();
    const shards = await storage.readdirNames("events/", ".jsonl");
    for (const name of shards) expect(await storage.readFile(`events/${name}`)).not.toContain("private-review-reason");
    await replayLedgerEvents({ store, storage });
    expect(state()).toBe("quarantined");
  });

  it("all profile read forms are fenced until current content is acknowledged", async () => {
    const scoped = scopeProfileStorageView(storage.withReviewStore(() => store), "profiles/test/", ISO);
    await scoped.writeFile("persona.md", "derived stale fact");
    expect(await scoped.readFile("persona.md")).toBe("derived stale fact");
    store.setL1ReviewStatus("root", "quarantined", ISO);
    expect(await scoped.readFile("persona.md")).toBeNull();
    expect(await scoped.readFileBuffer("persona.md")).toBeNull();
    const content = await scoped.readFile("persona.md", { review: false });
    const fence = await profileReviewFence(store, ISO);
    await acknowledgeDerivedReview(store, "persona.md", content!, { fence_hash: createHash("sha256").update(JSON.stringify([...fence].sort())).digest("hex"), content_hash: createHash("sha256").update(content!).digest("hex") }, ISO, { operation_id: "profile-read", reason: "verified" });
    expect(await scoped.readFile("persona.md")).toBe(content);
    await scoped.writeFile("persona.md", "changed after acknowledgement");
    expect(await scoped.readFile("persona.md")).toBeNull();
    expect(await derivedProfileAllowed(store, "persona.md", content!, fence, ISO)).toBe(true);
    expect(state()).toBe("quarantined");
  });

  it("clear fences a late profile even if no memory was ever manually retracted", async () => {
    const scoped = scopeProfileStorageView(storage.withReviewStore(() => store), "profiles/test/", ISO);
    store.appendMemoryEvent({ event_ts: new Date().toISOString(), session_key: "", session_id: "", team_id: "t1", agent_id: "a1", record_id: "clear", content: "", op: "deleted", scope: "agent", layer: "l1", source: "api_mutation" });
    await scoped.writeFile("persona.md", "late derived bytes");
    expect(await scoped.readFile("persona.md")).toBeNull();
  });

  it.each(["keyword", "embedding", "hybrid"] as const)("auto-recall %s preserves one formatted result and activity metadata", async (strategy) => {
    const { performAutoRecall } = await import("../hooks/auto-recall.js");
    const hit = { ...all()[0], score: 1, metadata_json: JSON.stringify({ activity_start_time: "2026-01-01T00:00:00.000Z", activity_end_time: "2026-02-01T00:00:00.000Z" }) };
    vi.spyOn(store, "searchL1Fts").mockReturnValue([hit]);
    vi.spyOn(store, "searchL1Vector").mockReturnValue([hit]);
    const embedding = { embed: vi.fn(async () => new Float32Array([1])) };
    const result = await performAutoRecall({ userText: "kubernetes", actorId: "u1", sessionKey: "sk", cfg: { recall: { strategy, timeoutMs: 5000, maxResults: 5, scoreThreshold: 0 } } as never, pluginDataDir: dir, vectorStore: store, embeddingService: embedding as never, storage, profileIsolation: ISO });
    expect(result?.error).toBeUndefined();
    expect(result?.recalledL1Memories).toHaveLength(1);
    expect(result?.recalledL1Memories?.[0].content).toBe("fact root");
    expect(result?.prependContext).toContain("2026-01-01 ~ 2026-02-01");
    if (strategy === "keyword") expect(embedding.embed).not.toHaveBeenCalled();
  });

  it.each([true, false])("auto-recall checks the native method before using capability (client embedding=%s)", async (clientEmbedding) => {
    const { performAutoRecall } = await import("../hooks/auto-recall.js");
    const hit = { ...all()[0], score: 1 };
    vi.spyOn(store, "getCapabilities").mockReturnValue({ ...store.getCapabilities(), nativeHybridSearch: true });
    const fts = vi.spyOn(store, "searchL1Fts").mockReturnValue([hit]);
    const vector = vi.spyOn(store, "searchL1Vector").mockReturnValue([hit]);
    const embedding = { embed: vi.fn(async () => new Float32Array([1])) };
    const result = await performAutoRecall({ userText: "kubernetes", actorId: "u1", sessionKey: "sk", cfg: { recall: { strategy: "hybrid", timeoutMs: 5000, maxResults: 5, scoreThreshold: 0 } } as never, pluginDataDir: dir, vectorStore: store, embeddingService: clientEmbedding ? embedding as never : undefined, storage, profileIsolation: ISO });
    expect(result?.error).toBeUndefined();
    expect(result?.recalledL1Memories).toHaveLength(1);
    expect(result?.recalledL1Memories?.[0].content).toBe("fact root");
    expect(fts).toHaveBeenCalled();
    expect(vector).toHaveBeenCalledTimes(clientEmbedding ? 1 : 0);
    expect(embedding.embed).toHaveBeenCalledTimes(clientEmbedding ? 1 : 0);
  });

  it("auto-recall invokes a real native method with its store receiver and no client embedding", async () => {
    const { performAutoRecall } = await import("../hooks/auto-recall.js");
    const hit = { ...all()[0], score: 0.75 };
    vi.spyOn(store, "getCapabilities").mockReturnValue({ ...store.getCapabilities(), nativeHybridSearch: true });
    const native = vi.fn(function (this: IMemoryStore, params: { query?: string; topK?: number }) {
      expect(this).toBe(store);
      expect(params).toEqual({ query: "kubernetes", topK: 5 });
      return [hit];
    });
    (store as IMemoryStore).searchL1Hybrid = native;
    const fts = vi.spyOn(store, "searchL1Fts");
    const vector = vi.spyOn(store, "searchL1Vector");
    const result = await performAutoRecall({ userText: "kubernetes", actorId: "u1", sessionKey: "sk", cfg: { recall: { strategy: "hybrid", timeoutMs: 5000, maxResults: 5, scoreThreshold: 0 } } as never, pluginDataDir: dir, vectorStore: store, storage, profileIsolation: ISO });
    expect(result?.error).toBeUndefined();
    expect(result?.recalledL1Memories).toMatchObject([{ content: "fact root", score: 0.75 }]);
    expect(native).toHaveBeenCalledTimes(1);
    expect(fts).not.toHaveBeenCalled();
    expect(vector).not.toHaveBeenCalled();
  });

  it("auto-recall cannot fall back to raw profile files when its ledger is unavailable and writes are disabled", async () => {
    const { performAutoRecall } = await import("../hooks/auto-recall.js");
    __setMemoryReviewEnabledForTests(false);
    const scoped = scopeProfileStorageView(storage, `profiles/${encodeURIComponent("team:t1|agent:a1")}/`, ISO);
    await scoped.writeFile("persona.md", "unverified fallback profile");
    const result = await performAutoRecall({ userText: "", actorId: "u1", sessionKey: "sk", cfg: { recall: { timeoutMs: 1000 } } as never, pluginDataDir: dir, storage, profileIsolation: ISO });
    expect(result).toMatchObject({ recalledL3Persona: null, prependContext: "", appendSystemContext: "", error: { code: 20002 }, partial: false });
  });

  it("a long-lived storage view cannot cache a clean fence across later retraction", async () => {
    const scoped = scopeProfileStorageView(storage.withReviewStore(() => store), "profiles/test/", ISO);
    await scoped.writeFile("persona.md", "initial profile");
    expect(await scoped.readFile("persona.md")).toBe("initial profile");
    store.setL1ReviewStatus("root", "quarantined", ISO);
    __setMemoryReviewEnabledForTests(false);
    expect(await scoped.readFile("persona.md")).toBeNull();
  });
});
