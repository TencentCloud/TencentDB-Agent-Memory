import { describe, expect, it } from "vitest";

import {
  readStableSystemContext,
  resolveStableContextPlacement,
  shapeOpenClawSystemContext,
  SYSTEM_PREFIX_MIN_VERSION,
  type StableContextPlacement,
} from "./system-context-placement.js";

const STABLE = "<user-persona>\nPrefers concise answers.\n</user-persona>";

describe("resolveStableContextPlacement", () => {
  it("uses the cacheable prefix on hosts at or above the minimum version", () => {
    const [major, minor, patch] = SYSTEM_PREFIX_MIN_VERSION;

    const atMin = resolveStableContextPlacement("auto", `${major}.${minor}.${patch}`);
    expect(atMin.effective).toBe("systemPrefix");
    expect(atMin.fallbackReason).toBeUndefined();

    const aboveMin = resolveStableContextPlacement("auto", `${major}.${minor}.${patch + 3}`);
    expect(aboveMin.effective).toBe("systemPrefix");
  });

  it("falls back to the legacy suffix just below the minimum version", () => {
    const [major, minor, patch] = SYSTEM_PREFIX_MIN_VERSION;

    const decision = resolveStableContextPlacement("auto", `${major}.${minor}.${patch - 1}`);

    expect(decision.effective).toBe("systemSuffix");
    expect(decision.fallbackReason).toBe("system-prefix-unsupported");
  });

  it.each([undefined, null, "", "unknown", "2026.4", "v2026.4.27", 20260427])(
    "falls back to the legacy suffix when the host version is unusable: %p",
    (rawVersion) => {
      const decision = resolveStableContextPlacement("auto", rawVersion);

      expect(decision.effective).toBe("systemSuffix");
      expect(decision.fallbackReason).toBe("unknown-host-version");
      expect(decision.hostVersion).toBeNull();
    },
  );

  it("honours an explicit request without consulting the host version", () => {
    // An operator who knows their host may opt in before the version table
    // catches up, and may opt out on a host that reports a new version but
    // runs a patched prompt builder.
    expect(resolveStableContextPlacement("systemPrefix", undefined).effective).toBe("systemPrefix");
    expect(resolveStableContextPlacement("systemPrefix", "2026.1.1").effective).toBe("systemPrefix");
    expect(resolveStableContextPlacement("systemSuffix", "2099.1.1").effective).toBe("systemSuffix");
  });

  it("reports no fallback reason for an explicit request", () => {
    expect(resolveStableContextPlacement("systemSuffix", undefined).fallbackReason).toBeUndefined();
  });
});

describe("shapeOpenClawSystemContext", () => {
  it("moves the stable block to the cacheable prefix", () => {
    const shaped = shapeOpenClawSystemContext(
      { appendSystemContext: STABLE, prependContext: "<relevant-memories>x</relevant-memories>" },
      "systemPrefix",
    );

    expect(shaped?.prependSystemContext).toBe(STABLE);
    expect(shaped?.appendSystemContext).toBeUndefined();
    // Dynamic recall is a separate concern and must not be relocated.
    expect(shaped?.prependContext).toBe("<relevant-memories>x</relevant-memories>");
  });

  it("keeps the stable block on the legacy suffix field", () => {
    const shaped = shapeOpenClawSystemContext({ appendSystemContext: STABLE }, "systemSuffix");

    expect(shaped?.appendSystemContext).toBe(STABLE);
    expect(shaped?.prependSystemContext).toBeUndefined();
  });

  it("preserves unrelated metric fields", () => {
    const shaped = shapeOpenClawSystemContext(
      {
        appendSystemContext: STABLE,
        recalledL3Persona: "Prefers concise answers.",
        recallStrategy: "hybrid",
      },
      "systemPrefix",
    );

    expect(shaped?.recalledL3Persona).toBe("Prefers concise answers.");
    expect(shaped?.recallStrategy).toBe("hybrid");
  });

  it("passes through a turn that carries no stable block", () => {
    const dynamicOnly = { prependContext: "<relevant-memories>x</relevant-memories>" };

    const shaped = shapeOpenClawSystemContext(dynamicOnly, "systemPrefix");

    expect(shaped?.prependSystemContext).toBeUndefined();
    expect(shaped?.appendSystemContext).toBeUndefined();
    expect(shaped?.prependContext).toBe("<relevant-memories>x</relevant-memories>");
  });

  it("returns undefined when recall produced nothing", () => {
    expect(shapeOpenClawSystemContext(undefined, "systemPrefix")).toBeUndefined();
  });
});

describe("stable context is never lost and never duplicated", () => {
  // The regression this guards against: routing the stable block to a field
  // the host does not implement drops persona and scene navigation entirely,
  // which is a silent capability loss rather than a cache regression. The
  // block must appear on exactly one field for every reachable combination
  // of operator request and host version.
  const placements: StableContextPlacement[] = ["auto", "systemPrefix", "systemSuffix"];
  const hostVersions: unknown[] = [
    undefined,
    null,
    "",
    "unknown",
    "2026.4",
    "2026.1.1",
    "2026.4.26",
    "2026.4.27",
    "2026.4.27-beta.1",
    "2026.5.28",
    "2099.12.31",
    42,
  ];

  for (const requested of placements) {
    for (const hostVersion of hostVersions) {
      it(`carries the stable block exactly once: placement=${requested}, host=${JSON.stringify(hostVersion)}`, () => {
        const decision = resolveStableContextPlacement(requested, hostVersion);
        const shaped = shapeOpenClawSystemContext({ appendSystemContext: STABLE }, decision.effective);
        const readBack = readStableSystemContext(shaped);

        expect(readBack.carriedBy).toHaveLength(1);
        expect(readBack.text).toBe(STABLE);
      });
    }
  }

  it("keeps the same bytes regardless of which field carries it", () => {
    const viaPrefix = shapeOpenClawSystemContext({ appendSystemContext: STABLE }, "systemPrefix");
    const viaSuffix = shapeOpenClawSystemContext({ appendSystemContext: STABLE }, "systemSuffix");

    expect(readStableSystemContext(viaPrefix).text).toBe(readStableSystemContext(viaSuffix).text);
  });
});
