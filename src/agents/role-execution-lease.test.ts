import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleGate } from "../gateway/consolidation/role-gate.js";
import { roleLockPath } from "../gateway/consolidation/role-lock.js";
import { acquireRoleExecutionLease } from "./role-execution-lease.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "role-lease-"));
  roots.push(value);
  return value;
}

describe("RoleExecutionLease integrity", () => {
  it("becomes dead when file-lock renewal loses ownership", async () => {
    vi.useFakeTimers();
    const dataDir = root();
    const gate = new RoleGate();
    const lease = acquireRoleExecutionLease({
      dataDir,
      roleKey: "extractor",
      ttlMs: 3_000,
      gate,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      nowMs: 1,
      now: () => Date.now(),
    })!;
    fs.writeFileSync(
      roleLockPath(dataDir, "extractor"),
      JSON.stringify({ token: "another-owner", pid: process.pid }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lease.isLive()).toBe(false);
    lease.release();
    expect(gate.isRoleLocked("extractor")).toBe(false);
  });

  it("fails closed when the lock directory is unusable", () => {
    const dataDir = path.join(root(), "not-a-directory");
    fs.writeFileSync(dataDir, "file");
    const gate = new RoleGate();
    expect(
      acquireRoleExecutionLease({
        dataDir,
        roleKey: "extractor",
        ttlMs: 1_000,
        gate,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        nowMs: 1,
      }),
    ).toBeNull();
    expect(gate.isRoleLocked("extractor")).toBe(false);
  });
});
