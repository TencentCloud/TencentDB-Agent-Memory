/**
 * Fix #549 Regression-Tests: L1-Drain-Resilience
 *
 * Defect 1: L1-drain-Task darf bei Lock-Conflict-Timeout NICHT gedroppt
 *           werden (Kette bricht still) — stattdessen re-enqueue mit Grenze.
 * Defect 2: flush muss L1 tatsächlich ausführen (nicht nur handleSessionEnd).
 */
import { describe, expect, it } from "vitest";
import { isL1DrainTask } from "../../src/services/pipeline-worker.js";

describe("Fix #549 Defect 1: L1-drain-Task-Erkennung", () => {
  it("erkennt L1-drain-Task am ID-Präfix (L1-drain-)", () => {
    expect(isL1DrainTask({ type: "L1", id: "L1-drain-sess-123" })).toBe(true);
  });

  it("verwirft normale L1-Tasks (threshold) — nur Drain wird re-enqueued", () => {
    expect(isL1DrainTask({ type: "L1", id: "L1-threshold-sess-1" })).toBe(false);
  });

  it("verwirft flush-Tasks", () => {
    expect(isL1DrainTask({ type: "flush", id: "flush-sess-1" })).toBe(false);
  });
});
