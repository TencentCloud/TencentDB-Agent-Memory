/**
 * Simulation-level tests for the prompt-cache stability work (issue #120).
 *
 * These exercise the *models* in this directory rather than shipped runtime
 * code, which is why they live outside `src/`: the models are analysis tooling
 * and must never end up in the published package.
 *
 * The assertions deliberately target the **shape** of the result (ordering,
 * monotonicity, sign of the delta) rather than absolute numbers.  Absolute
 * numbers here are a function of hand-picked corpus constants and would make
 * the suite brittle without proving anything extra.
 */
import { describe, it, expect } from "vitest";
import {
  buildScenario,
  simulateSession,
  runComparison,
  runSensitivitySweep,
  DEFAULT_SCENARIO,
} from "./prefix-cache-sim.js";
import {
  simulateBloat,
  runBloatComparison,
  DEFAULT_BLOAT,
} from "./show-injected-bloat.js";

describe("prefix cache simulation", () => {
  it("the optimized policy beats the baseline on the same conversation", () => {
    const scenario = buildScenario(DEFAULT_SCENARIO);
    const baseline = simulateSession(scenario, { label: "baseline", options: { enabled: false } });
    const optimized = simulateSession(scenario, { label: "optimized", options: { enabled: true } });

    expect(baseline.totalPromptTokens).toBeGreaterThan(0);
    expect(optimized.totalPromptTokens).toBeGreaterThan(0);
    expect(optimized.hitRate).toBeGreaterThan(baseline.hitRate);
    // The regression this fixes was a ~28pp drop; the fix must recover most of it.
    expect(optimized.hitRate - baseline.hitRate).toBeGreaterThan(0.15);
    expect(optimized.hitRate).toBeGreaterThan(0.85);
  });

  it("every individual optimization is a net win", () => {
    const rows = runComparison();
    const byLabel = new Map(rows.map((r) => [r.label, r.stats.hitRate]));
    const baseline = byLabel.get("baseline (v0.3.6)")!;

    for (const [label, rate] of byLabel) {
      if (label === "baseline (v0.3.6)") continue;
      expect(rate, `${label} should not regress below baseline`).toBeGreaterThanOrEqual(baseline);
    }
    expect(byLabel.get("all optimizations")!).toBeGreaterThan(baseline);
  });

  it("the optimized policy sends fewer prompt tokens overall", () => {
    const scenario = buildScenario(DEFAULT_SCENARIO);
    const baseline = simulateSession(scenario, { label: "baseline", options: { enabled: false } });
    const optimized = simulateSession(scenario, { label: "optimized", options: { enabled: true } });
    // Dedup removes repeated memory lines from the request entirely.
    expect(optimized.totalPromptTokens).toBeLessThan(baseline.totalPromptTokens);
  });

  it("cold start is always a full miss", () => {
    const scenario = buildScenario({ ...DEFAULT_SCENARIO, turns: 3 });
    const stats = simulateSession(scenario, { label: "optimized", options: { enabled: true } });
    expect(stats.turns[0].cachedTokens).toBe(0);
    expect(stats.turns[0].note).toBe("cold-start");
  });
});

describe("sensitivity to background write frequency", () => {
  // These are the only claims from the simulator that survive scrutiny: the
  // absolute hit rate is a function of hand-picked corpus constants, but the
  // *shape* of the result is not.  Assert the shape.
  const summary = runSensitivitySweep();

  it("never regresses, on any parameter combination", () => {
    expect(summary.regressions).toBe(0);
    expect(summary.minDelta).toBeGreaterThanOrEqual(0);
  });

  it("baseline swings wildly — so no single baseline number is quotable", () => {
    // If this ever narrows, the sweep has stopped covering the interesting
    // range and the "removes variance" claim below becomes untestable.
    expect(summary.baselineMax - summary.baselineMin).toBeGreaterThan(0.5);
  });

  it("the policy collapses that variance into a flat line", () => {
    const optimizedSpread = summary.optimizedMax - summary.optimizedMin;
    const baselineSpread = summary.baselineMax - summary.baselineMin;
    expect(optimizedSpread).toBeLessThan(0.05);
    expect(optimizedSpread).toBeLessThan(baselineSpread / 10);
  });

  it("holds up even when the background pipelines are idle", () => {
    // Worst case for the policy: nothing churns, so there is little to fix.
    // It must still not hurt.
    const idle = summary.cells.find(
      (c) => c.sceneHeatBumpEveryTurns === 999 && c.personaRegenEveryTurns === 999,
    )!;
    expect(idle.delta).toBeGreaterThanOrEqual(0);
    // And the baseline recovering on its own here is what pins the root cause
    // on background writes rather than on per-turn injection.
    expect(idle.baselineHitRate).toBeGreaterThan(0.9);
  });
});

describe("showInjected conversation bloat", () => {
  const [ephemeral, bloated, deduped] = runBloatComparison();

  it("showInjected=true compounds while showInjected=false does not", () => {
    // The ephemeral variant pays a flat per-turn cost; the frozen variant
    // carries every past injection forward.  The gap must therefore widen
    // monotonically, which is the whole claim behind "context bloat".
    const gapAt = (turn: number) =>
      bloated.turns[turn - 1].promptTokens - ephemeral.turns[turn - 1].promptTokens;
    expect(gapAt(10)).toBeGreaterThan(gapAt(5));
    expect(gapAt(20)).toBeGreaterThan(gapAt(10));
    expect(gapAt(40)).toBeGreaterThan(gapAt(20));
  });

  it("turn 1 is identical across variants — nothing has accumulated yet", () => {
    expect(bloated.turns[0].promptTokens).toBe(ephemeral.turns[0].promptTokens);
    expect(deduped.turns[0].promptTokens).toBe(ephemeral.turns[0].promptTokens);
  });

  it("session dedup recovers a large share of the bloat", () => {
    const bloat = bloated.finalPromptTokens - ephemeral.finalPromptTokens;
    const recovered = bloated.finalPromptTokens - deduped.finalPromptTokens;
    expect(recovered / bloat).toBeGreaterThan(0.4);
    // Dedup cannot beat never-storing-it: that is the floor.
    expect(deduped.finalPromptTokens).toBeGreaterThanOrEqual(ephemeral.finalPromptTokens);
  });

  it("dedup delays the onset of truncation in long sessions", () => {
    const long = { ...DEFAULT_BLOAT, turns: 80 };
    const b = simulateBloat(long, { label: "b", showInjected: true, dedup: false });
    const d = simulateBloat(long, { label: "d", showInjected: true, dedup: true });
    expect(b.firstTruncationTurn).not.toBeNull();
    expect(d.firstTruncationTurn).not.toBeNull();
    // Truncation is what makes the history prefix inconsistent, so pushing it
    // later is a direct cache benefit — this is the link the issue describes.
    expect(d.firstTruncationTurn!).toBeGreaterThan(b.firstTruncationTurn!);
  });

  it("dedup pays off more as recall repeats more", () => {
    const saving = (repeatRate: number) => {
      const o = { ...DEFAULT_BLOAT, repeatRate };
      const b = simulateBloat(o, { label: "b", showInjected: true, dedup: false });
      const d = simulateBloat(o, { label: "d", showInjected: true, dedup: true });
      return (b.finalPromptTokens - d.finalPromptTokens) / b.finalPromptTokens;
    };
    expect(saving(0.85)).toBeGreaterThan(saving(0.5));
    expect(saving(0.5)).toBeGreaterThan(saving(0.3));
  });
});
