import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiOutboxStore, type PiOutboxInput } from "../pi-outbox-store.js";
import { PiOutboxWorker } from "../pi-outbox-worker.js";
import { runPiOutboxCommand } from "../pi-outbox-cli.js";

const dirs: string[] = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), "pi-worker-")); dirs.push(dir); return dir; }
function input(key = "turn-1"): PiOutboxInput {
  return { scope: { serviceId: "s", teamId: "t", agentId: "a", userId: "u", sessionId: "session" },
    body: JSON.stringify({ session_id: "session", idempotency_key: key, messages: [{ role: "user", content: "private conversation" }] }) };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("Pi durable delivery policy (#1391)", () => {
  it("persists retry count and schedule through restarts, then quarantines at the ceiling", async () => {
    let now = 1_000;
    const dir = await directory();
    const store = new PiOutboxStore(dir, () => now);
    const original = await store.enqueue(input());
    const send = vi.fn().mockResolvedValue({ ok: false, retryable: true, reason: "network" });
    const policy = { maxAttempts: 2, baseRetryMs: 100 };
    expect(await new PiOutboxWorker(store, send, policy).flush()).toMatchObject({ retried: 1 });
    expect((await store.inspect()).entries[0]).toMatchObject({ attempts: 1, availableAt: 1_100, reason: "network" });
    const restarted = new PiOutboxStore(dir, () => now);
    expect(await new PiOutboxWorker(restarted, send, policy).flush()).toMatchObject({ retried: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    now = 1_100;
    expect(await new PiOutboxWorker(restarted, send, policy).flush()).toMatchObject({ dead: 1 });
    expect((await store.inspect()).entries[0]).toMatchObject({ state: "dead", attempts: 2 });
    expect((await store.recover()).records).toEqual([]);
    expect(send.mock.calls[1][0].body).toBe(original.body);
    expect(await restarted.redrive(original.id)).toBe(true);
    expect(await restarted.redrive(original.id)).toBe(false);
    const success = vi.fn().mockResolvedValue({ ok: true });
    expect(await new PiOutboxWorker(restarted, success).flush()).toMatchObject({ delivered: 1 });
    expect(success.mock.calls[0][0].body).toBe(original.body);
    expect((await store.inspect()).entries).toEqual([]);
  });

  it("isolates a conflict while delivering a healthy record and reporting damaged files", async () => {
    const dir = await directory();
    const store = new PiOutboxStore(dir);
    const bad = await store.enqueue(input("conflict"));
    await store.enqueue(input("healthy"));
    await writeFile(join(dir, "00000000-0000-0000-0000-000000000000.json"), "broken secret");
    const worker = new PiOutboxWorker(store, async record => record.id === bad.id
      ? { ok: false, retryable: false, reason: "conflict" } : { ok: true });
    const result = await worker.flush();
    expect(result).toMatchObject({ dead: 1, delivered: 1, errors: [] });
    expect(result.unreadable).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect((await store.inspect()).entries[0]).toMatchObject({ id: bad.id, reason: "conflict" });
  });

  it("renews automatically during slow delivery so another worker cannot take over", async () => {
    const dir = await directory();
    const store = new PiOutboxStore(dir);
    const record = await store.enqueue(input());
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const worker = new PiOutboxWorker(store, async () => {
      started(); await delay(1_500); return { ok: true };
    }, { leaseMs: 600, timeoutMs: 3_000 });
    const pass = worker.flush();
    await ready;
    await delay(900);
    expect(await new PiOutboxStore(dir).claim(record.id)).toBeNull();
    expect(await pass).toMatchObject({ delivered: 1, lost: 0 });
  });

  it("aborts a send and never ACKs after heartbeat ownership is lost", async () => {
    const store = new PiOutboxStore(await directory());
    await store.enqueue(input());
    vi.spyOn(store, "renew").mockResolvedValue(null);
    const ack = vi.spyOn(store, "acknowledge");
    let observedSignal: AbortSignal | undefined;
    const worker = new PiOutboxWorker(store, async (_record, signal) => {
      observedSignal = signal; await delay(150); return { ok: true };
    }, { leaseMs: 90, timeoutMs: 1_000 });
    expect(await worker.flush()).toMatchObject({ lost: 1, delivered: 0 });
    expect(observedSignal?.aborted).toBe(true);
    await delay(180);
    expect(ack).not.toHaveBeenCalled();
    expect((await store.inspect()).entries).toHaveLength(1);
  });

  it("bounds a stuck sender even when it ignores AbortSignal", async () => {
    const store = new PiOutboxStore(await directory());
    await store.enqueue(input());
    const worker = new PiOutboxWorker(store, () => new Promise(() => {}), { timeoutMs: 50 });
    expect(await worker.flush()).toMatchObject({ retried: 1 });
    expect((await store.inspect()).entries[0]).toMatchObject({ state: "pending", reason: "timeout" });
  });

  it("preserves the lease and reports the record ID if the local ACK write fails", async () => {
    const store = new PiOutboxStore(await directory());
    const record = await store.enqueue(input());
    vi.spyOn(store, "acknowledge").mockRejectedValue(new Error("disk failure: sensitive path"));
    const result = await new PiOutboxWorker(store, async () => ({ ok: true })).flush();
    expect(result).toMatchObject({ delivered: 0, errors: [record.id] });
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect((await store.inspect()).entries[0]).toMatchObject({ id: record.id, state: "leased" });
  });

  it("shares concurrent flush calls and releases pending work on shutdown", async () => {
    const store = new PiOutboxStore(await directory());
    await store.enqueue(input());
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const send = vi.fn(() => { started(); return new Promise<never>(() => {}); });
    const worker = new PiOutboxWorker(store, send);
    const first = worker.flush(controller.signal);
    expect(worker.flush(controller.signal)).toBe(first);
    await ready;
    controller.abort();
    expect(await first).toMatchObject({ retried: 1, dead: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not send again when interrupted attempts have already consumed the budget", async () => {
    let now = 1_000;
    const store = new PiOutboxStore(await directory(), () => now);
    const record = await store.enqueue(input());
    await store.claim(record.id, 100);
    now = 1_100;
    const send = vi.fn();
    expect(await new PiOutboxWorker(store, send, { maxAttempts: 1 }).flush()).toMatchObject({ dead: 1 });
    expect(send).not.toHaveBeenCalled();
    expect((await store.inspect()).entries[0].reason).toBe("exhausted");
  });

  it("polls until stopped and cleans up an idle polling wait", async () => {
    const store = new PiOutboxStore(await directory());
    await store.enqueue(input());
    const controller = new AbortController();
    const results: number[] = [];
    await new PiOutboxWorker(store, async () => ({ ok: true })).run(controller.signal, result => {
      results.push(result.delivered); controller.abort();
    });
    expect(results).toEqual([1]);
  });

  it("provides payload-free operator listing and explicit single-record redrive", async () => {
    const dir = await directory();
    const store = new PiOutboxStore(dir);
    const record = await store.enqueue(input());
    await store.deadLetter((await store.claim(record.id))!, "auth");
    const output = vi.fn();
    expect(await runPiOutboxCommand(["list", dir], {}, output)).toBe(0);
    expect(output.mock.calls[0][0]).toContain('"auth"');
    expect(output.mock.calls[0][0]).not.toContain("private conversation");
    expect(await runPiOutboxCommand(["redrive", dir, record.id], {}, output)).toBe(0);
    expect((await store.recover()).records[0].body).toBe(record.body);
    await expect(runPiOutboxCommand(["flush", dir], {}, output)).rejects.toThrow("verified compatible gateway");
    await expect(runPiOutboxCommand(["redrive", dir, "../outside"], {}, output)).rejects.toThrow("Invalid outbox record ID");
  });
});
