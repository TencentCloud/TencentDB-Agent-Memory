/**
 * RoleGate — per-role single-flight unit tests (forked task-cycle roles:
 * memory-keeper / night-keeper / dedup-daily run in parallel; same role
 * never overlaps itself).
 */
import { describe, it, expect } from "vitest";
import { RoleGate } from "./role-gate.js";

describe("RoleGate (per-role single-flight)", () => {
  it("different roles acquire concurrently", () => {
    const gate = new RoleGate();
    const a = gate.tryAcquire("memory-keeper");
    const b = gate.tryAcquire("night-keeper");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(gate.isLocked).toBe(true);
    expect(gate.isRoleLocked("memory-keeper")).toBe(true);
    expect(gate.isRoleLocked("night-keeper")).toBe(true);
  });

  it("same role: second acquire is refused", () => {
    const gate = new RoleGate();
    const a = gate.tryAcquire("memory-keeper");
    expect(a).not.toBeNull();
    expect(gate.tryAcquire("memory-keeper")).toBeNull();
    expect(gate.isRoleLocked("memory-keeper")).toBe(true);
    // Other role unaffected.
    expect(gate.tryAcquire("dedup-daily")).not.toBeNull();
  });

  it("release unlocks the role (idempotent)", () => {
    const gate = new RoleGate();
    const a = gate.tryAcquire("memory-keeper")!;
    a();
    a(); // second release is a no-op
    expect(gate.isRoleLocked("memory-keeper")).toBe(false);
    expect(gate.tryAcquire("memory-keeper")).not.toBeNull();
  });

  it("isLocked = any role active; false when all released", () => {
    const gate = new RoleGate();
    expect(gate.isLocked).toBe(false);
    const a = gate.tryAcquire("memory-keeper")!;
    const b = gate.tryAcquire("night-keeper")!;
    expect(gate.isLocked).toBe(true);
    a();
    expect(gate.isLocked).toBe(true); // night-keeper still active
    b();
    expect(gate.isLocked).toBe(false);
  });
});
