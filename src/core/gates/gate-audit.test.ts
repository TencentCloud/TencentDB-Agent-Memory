import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AuditGate } from "./gate-audit.js";
import type { AuditEntry } from "./types.js";

describe("AuditGate", () => {
  let gate: AuditGate;
  beforeEach(() => {
    vi.useFakeTimers();
    gate = new AuditGate({ maxBufferSize: 5, intervalMs: 5000, sampleRate: 1.0 });
  });
  afterEach(() => { gate.dispose(); vi.useRealTimers(); });

  it("records entries on afterCall", () => {
    gate.afterCall("recall", { ok: true }, 42);
    gate.afterCall("capture", { ok: true }, 15);
    expect(gate._bufferSize()).toBe(2);
  });

  it("drops oldest entry when buffer is full", () => {
    const dropped: AuditEntry[] = [];
    gate = new AuditGate({ maxBufferSize: 2, intervalMs: 5000, sampleRate: 1.0, onDrop: (e) => dropped.push(e) });
    gate.afterCall("m1", null, 10); gate.afterCall("m2", null, 10); gate.afterCall("m3", null, 10);
    expect(gate._bufferSize()).toBe(2);
    expect(dropped.length).toBe(1);
    expect(dropped[0].method).toBe("m1");
  });

  it("flushes buffer to console exporter", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    gate.afterCall("recall", { ok: true }, 42);
    gate.afterCall("capture", { ok: true }, 15);
    await gate._flushNow();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]).toContain("[AUDIT]");
    console.log = origLog;
  });

  it("tracks drop count under load", () => {
    gate = new AuditGate({ maxBufferSize: 3, intervalMs: 5000, sampleRate: 1.0 });
    for (let i = 0; i < 10; i++) gate.afterCall(`m${i}`, null, 1);
    expect(gate._bufferSize()).toBe(3);
    expect(gate._getDropCount()).toBe(7);
  });
});
