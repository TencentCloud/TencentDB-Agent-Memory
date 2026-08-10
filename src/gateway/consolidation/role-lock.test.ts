/**
 * role-lock unit level: the acquire/takeover rules. The cross-process wiring
 * is proven separately in role-lock.cross-process.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireRoleLock, roleLockPath } from "./role-lock.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-rl-"));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const TTL = { ttlMs: 60_000 };

describe("acquireRoleLock", () => {
  it("second acquire of the same role is refused while the first is held", () => {
    const first = acquireRoleLock(dataDir, "r", TTL);
    expect(first).not.toBeNull();
    expect(acquireRoleLock(dataDir, "r", TTL)).toBeNull();
    first!.release();
    expect(acquireRoleLock(dataDir, "r", TTL)).not.toBeNull();
  });

  it("different roles do not block each other", () => {
    expect(acquireRoleLock(dataDir, "a", TTL)).not.toBeNull();
    expect(acquireRoleLock(dataDir, "b", TTL)).not.toBeNull();
  });

  it("the lock file is never left empty: it carries the owner as soon as it exists", () => {
    const lock = acquireRoleLock(dataDir, "r", TTL)!;
    const raw = fs.readFileSync(lock.path, "utf-8");
    expect(raw.length).toBeGreaterThan(0);
    expect(JSON.parse(raw)).toMatchObject({
      pid: process.pid,
      host: os.hostname(),
      role: "r",
    });
  });

  it("an expired lock is taken over", () => {
    const t0 = Date.now();
    expect(
      acquireRoleLock(dataDir, "r", { ttlMs: 1_000, nowMs: t0 }),
    ).not.toBeNull();
    expect(
      acquireRoleLock(dataDir, "r", { ttlMs: 1_000, nowMs: t0 + 500 }),
    ).toBeNull();
    expect(
      acquireRoleLock(dataDir, "r", { ttlMs: 1_000, nowMs: t0 + 2_000 }),
    ).not.toBeNull();
  });

  it("a dead pid on THIS host is taken over; a live foreign host is not", () => {
    const file = roleLockPath(dataDir, "r");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const future = new Date(Date.now() + 600_000).toISOString();
    // Dead local pid (pid 2^22 is above the default pid_max).
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: 4_194_303,
        host: os.hostname(),
        role: "r",
        acquiredAt: new Date().toISOString(),
        expiresAt: future,
      }),
      "utf-8",
    );
    expect(acquireRoleLock(dataDir, "r", TTL)).not.toBeNull();

    // Another host, ttl not expired → never probed for liveness, never stolen.
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: process.pid,
        host: "some-other-host",
        role: "r",
        acquiredAt: new Date().toISOString(),
        expiresAt: future,
      }),
      "utf-8",
    );
    expect(acquireRoleLock(dataDir, "r", TTL)).toBeNull();
  });

  it("release is idempotent and never removes someone else's lock", () => {
    const lock = acquireRoleLock(dataDir, "r", TTL)!;
    lock.release();
    const other = acquireRoleLock(dataDir, "r", TTL)!;
    lock.release(); // second release of the old handle
    expect(fs.existsSync(other.path)).toBe(true);
  });

  it("an unparseable leftover file is treated as a leftover, not an owner", () => {
    const file = roleLockPath(dataDir, "r");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ broken", "utf-8");
    expect(acquireRoleLock(dataDir, "r", TTL)).not.toBeNull();
  });
});
