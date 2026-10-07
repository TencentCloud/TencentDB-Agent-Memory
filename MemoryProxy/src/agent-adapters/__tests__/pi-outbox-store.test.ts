import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PiOutboxStore, preparePiOutboxInput, type PiOutboxInput } from "../pi-outbox-store.js";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pi-outbox-test-"));
  directories.push(path);
  return path;
}
function input(): PiOutboxInput {
  return {
    scope: { serviceId: "s", teamId: "t", agentId: "a", userId: "u", sessionId: "session" },
    body: JSON.stringify({ session_id: "session", idempotency_key: "turn-1", messages: [
      { role: "user", content: "使用 Java 21", timestamp: "2026-10-06T00:00:00Z" },
    ] }),
  };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("Pi outbox storage and leases", () => {
  it("propagates turn.key exactly and rejects oversized messages without truncating", () => {
    const turn = { key: "stable-turn-123", messages: [{ role: "user" as const, content: "hello" }] };
    const prepared = preparePiOutboxInput(input().scope, turn);
    expect(JSON.parse(prepared.body)).toEqual({ session_id: "session", idempotency_key: turn.key, messages: turn.messages });
    turn.messages[0].content = "changed";
    expect(JSON.parse(prepared.body).messages[0].content).toBe("hello");
    expect(() => preparePiOutboxInput(input().scope, { ...turn, messages: [{ role: "user", content: "x".repeat(8193) }] })).toThrow("8192");
  });

  it("rejects conflicting body identities and authentication fields before persisting", async () => {
    const store = new PiOutboxStore(await directory());
    for (const extra of [{ team_id: "other-team" }, { api_key: "secret" }]) {
      await expect(store.enqueue({ ...input(), body: JSON.stringify({ ...JSON.parse(input().body), ...extra }) })).rejects.toThrow();
    }
    for (const extra of [{ api_key: "secret" }, { timestamp: "invalid" }]) {
      const body = JSON.parse(input().body);
      Object.assign(body.messages[0], extra);
      await expect(store.enqueue({ ...input(), body: JSON.stringify(body) })).rejects.toThrow();
    }
    expect((await store.inspect()).entries).toEqual([]);
  });

  it("recovers a record persisted by a separate process that exits without acknowledging", async () => {
    const path = await directory();
    // Native Node type stripping: exercise a real process boundary, without Vitest mocks.
    const moduleUrl = new URL("../pi-outbox-store.ts", import.meta.url).href;
    await promisify(execFile)(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e",
      `import { PiOutboxStore } from ${JSON.stringify(moduleUrl)};
       await new PiOutboxStore(process.env.PI_OUTBOX_TEST_DIR).enqueue(JSON.parse(process.env.PI_OUTBOX_TEST_INPUT));
       process.exit(0);`,
    ], { env: { ...process.env, PI_OUTBOX_TEST_DIR: path, PI_OUTBOX_TEST_INPUT: JSON.stringify(input()) } });
    const recovered = await new PiOutboxStore(path).recover();
    expect(recovered.unreadable).toEqual([]);
    expect(recovered.records).toHaveLength(1);
    expect(recovered.records[0]).toMatchObject(input());
  });

  it("recovers exact delivery bytes and scope through a new store instance", async () => {
    const path = await directory();
    const request = input();
    const original = structuredClone(request);
    const pending = new PiOutboxStore(path).enqueue(request);
    request.scope.sessionId = "changed";
    request.body = "changed";
    const record = await pending;
    expect(record).toMatchObject(original);
    expect(await new PiOutboxStore(path).recover()).toEqual({ records: [record], unreadable: [] });
  });

  it("keeps partial temporary files invisible and reports corrupt records without losing healthy ones", async () => {
    const path = await directory();
    const store = new PiOutboxStore(path);
    const record = await store.enqueue(input());
    const badName = "00000000-0000-0000-0000-000000000000.json";
    await writeFile(join(path, "unfinished.tmp"), '{"partial":');
    await writeFile(join(path, badName), "private broken content");
    expect(await store.recover()).toEqual({
      records: [record], unreadable: [{ file: badName, reason: "Unable to read or validate outbox record" }],
    });
    expect(await readFile(join(path, badName), "utf8")).toBe("private broken content");
  });

  it("does not overwrite records during concurrent enqueues", async () => {
    const path = await directory();
    const records = await Promise.all(Array.from({ length: 20 }, () => new PiOutboxStore(path).enqueue(input())));
    expect(new Set(records.map(record => record.id)).size).toBe(20);
    expect((await new PiOutboxStore(path).recover()).records).toHaveLength(20);
  });

  it("acknowledges only the owned record and safely rejects repeated acknowledgement", async () => {
    const store = new PiOutboxStore(await directory());
    const first = await store.enqueue(input());
    const second = await store.enqueue(input());
    const lease = (await store.claim(first.id))!;
    expect(await store.acknowledge(lease)).toBe(true);
    expect(await store.acknowledge(lease)).toBe(false);
    expect((await store.recover()).records).toEqual([second]);
    await expect(store.claim("../outside")).rejects.toThrow("Invalid outbox record ID");
  });

  it("rejects requests missing the retry contract before persisting", async () => {
    const store = new PiOutboxStore(await directory());
    for (const body of ["null", "{}", JSON.stringify({ session_id: "other", idempotency_key: "turn-1", messages: [{}] })]) {
      await expect(store.enqueue({ ...input(), body })).rejects.toThrow();
    }
    expect((await store.recover()).records).toEqual([]);
  });

  it("treats a not-yet-created queue as empty", async () => {
    const store = new PiOutboxStore(join(await directory(), "new"));
    expect(await store.recover()).toEqual({ records: [], unreadable: [] });
  });

  it("surfaces local storage failure instead of reporting successful enqueue", async () => {
    const path = join(await directory(), "not-a-directory");
    await writeFile(path, "existing data");
    await expect(new PiOutboxStore(path).enqueue(input())).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("existing data");
  });

  it("allows only one of two independent processes to claim a pending record", async () => {
    const path = await directory();
    const store = new PiOutboxStore(path);
    const record = await store.enqueue(input());
    const moduleUrl = new URL("../pi-outbox-store.ts", import.meta.url).href;
    const worker = () => promisify(execFile)(process.execPath, [
      "--experimental-transform-types", "--input-type=module", "-e",
      `import { PiOutboxStore } from ${JSON.stringify(moduleUrl)};
       const lease = await new PiOutboxStore(process.env.PI_OUTBOX_TEST_DIR).claim(process.env.PI_OUTBOX_TEST_ID);
       console.log(JSON.stringify(lease));`,
    ], { env: { ...process.env, PI_OUTBOX_TEST_DIR: path, PI_OUTBOX_TEST_ID: record.id } });
    const results = await Promise.all([worker(), worker()]);
    const claims = results.map(result => JSON.parse(result.stdout)).filter(Boolean);
    expect(claims).toHaveLength(1);
    expect((await store.recover()).records).toEqual([]);
    expect(await store.acknowledge(claims[0])).toBe(true);
  });

  it("renews a lease past its original expiry and invalidates its old token", async () => {
    let now = 1_000;
    const store = new PiOutboxStore(await directory(), () => now);
    const record = await store.enqueue(input());
    const first = (await store.claim(record.id, 100))!;
    now = 1_050;
    const renewed = (await store.renew(first, 100))!;
    expect(renewed).not.toBeNull();
    expect(await store.acknowledge(first)).toBe(false);
    expect(await store.release(first)).toBe(false);
    now = 1_110;
    expect(await store.claim(record.id, 100)).toBeNull();
    expect((await store.recover()).records).toEqual([]);
    expect(await store.acknowledge(renewed)).toBe(true);
  });

  it("reclaims an expired lease without allowing the old owner to delete or release it", async () => {
    let now = 1_000;
    const path = await directory();
    // The old owner still believes its lease is live: fencing must rely on the
    // unique filename, not just the local wall-clock expiry check.
    const firstStore = new PiOutboxStore(path, () => 1_000);
    const secondStore = new PiOutboxStore(path, () => now);
    const record = await firstStore.enqueue(input());
    const oldLease = (await firstStore.claim(record.id, 100))!;
    now = 1_100;
    expect((await secondStore.recover()).records).toEqual([record]);
    const newLease = (await secondStore.claim(record.id, 100))!;
    expect(newLease.token).not.toBe(oldLease.token);
    expect(await firstStore.renew(oldLease)).toBeNull();
    expect(await firstStore.release(oldLease)).toBe(false);
    expect(await firstStore.acknowledge(oldLease)).toBe(false);
    expect(await secondStore.acknowledge(newLease)).toBe(true);
  });

  it("recovers after a lease holder is forcibly killed", async () => {
    const path = await directory();
    const record = await new PiOutboxStore(path).enqueue(input());
    const moduleUrl = new URL("../pi-outbox-store.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e",
      `import { PiOutboxStore } from ${JSON.stringify(moduleUrl)};
       const lease = await new PiOutboxStore(process.env.PI_OUTBOX_TEST_DIR).claim(process.env.PI_OUTBOX_TEST_ID);
       process.send(lease);
       setInterval(() => {}, 1000);`,
    ], {
      env: { ...process.env, PI_OUTBOX_TEST_DIR: path, PI_OUTBOX_TEST_ID: record.id },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exit = once(child, "exit");
    try {
      const [lease] = await once(child, "message", { signal: AbortSignal.timeout(5_000) });
      child.kill("SIGKILL");
      await exit;
      // Advance the recovery clock deterministically instead of waiting 30 seconds.
      const restarted = new PiOutboxStore(path, () => lease.expiresAt + 1);
      expect((await restarted.recover()).records).toEqual([record]);
      const reclaimed = (await restarted.claim(record.id))!;
      expect(await restarted.acknowledge(reclaimed)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    }
  });

  it("returns a released record to pending with unchanged content", async () => {
    const store = new PiOutboxStore(await directory());
    const record = await store.enqueue(input());
    const lease = (await store.claim(record.id))!;
    expect(await store.release(lease)).toBe(true);
    expect((await store.recover()).records).toEqual([record]);
    const replacement = (await store.claim(record.id))!;
    expect(await store.release(lease)).toBe(false);
    expect(await store.acknowledge(lease)).toBe(false);
    expect(await store.acknowledge(replacement)).toBe(true);
  });

  it.each([0, -1, 0.5, Infinity, 86_400_001])("rejects invalid lease duration %s", async ttl => {
    const store = new PiOutboxStore(await directory());
    const record = await store.enqueue(input());
    await expect(store.claim(record.id, ttl)).rejects.toThrow("Lease duration");
    expect((await store.recover()).records).toEqual([record]);
  });
});
