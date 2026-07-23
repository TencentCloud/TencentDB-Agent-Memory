import { describe, expect, it } from "vitest";
import {
  resolveOpenClawRecallCompatibility,
  shapeOpenClawRecallResult,
} from "./recall-injection.js";

describe("resolveOpenClawRecallCompatibility", () => {
  it("keeps prepend mode on old and unknown hosts", () => {
    expect(resolveOpenClawRecallCompatibility("prepend", undefined)).toMatchObject({
      effectiveMode: "prepend",
      hostVersion: null,
      supportsPrependSystemContext: false,
    });

    expect(resolveOpenClawRecallCompatibility("append", "2026.4.26")).toMatchObject({
      effectiveMode: "prepend",
      hostVersion: [2026, 4, 26],
      supportsPrependSystemContext: true,
      fallbackReason: "append-context-unsupported",
    });

    expect(resolveOpenClawRecallCompatibility("append", undefined)).toMatchObject({
      effectiveMode: "prepend",
      fallbackReason: "unknown-host-version",
    });
  });

  it("enables appendContext at the v2026.4.27 boundary", () => {
    expect(resolveOpenClawRecallCompatibility("append", "2026.4.27-beta.1")).toEqual({
      requestedMode: "append",
      effectiveMode: "append",
      hostVersion: [2026, 4, 27],
      supportsPrependSystemContext: true,
    });
  });
});

describe("shapeOpenClawRecallResult", () => {
  const recallResult = {
    appendSystemContext: "<user-persona>stable</user-persona>",
    prependContext: "<relevant-memories>dynamic</relevant-memories>",
    recalledL1Memories: [{ content: "dynamic", score: 0.9, type: "fact" }],
    recalledL3Persona: "stable",
    recallStrategy: "hybrid",
  };

  it("maps stable and dynamic context to cache-aware fields on supported hosts", () => {
    const compatibility = resolveOpenClawRecallCompatibility("append", "2026.4.27");
    const result = shapeOpenClawRecallResult(recallResult, compatibility);

    expect(result).toEqual({
      prependSystemContext: "<user-persona>stable</user-persona>",
      appendContext: "<relevant-memories>dynamic</relevant-memories>",
      recalledL1Memories: [{ content: "dynamic", score: 0.9, type: "fact" }],
      recalledL3Persona: "stable",
      recallStrategy: "hybrid",
    });
  });

  it("falls back without losing recall on older hosts", () => {
    const compatibility = resolveOpenClawRecallCompatibility("append", "2026.4.26");
    const result = shapeOpenClawRecallResult(recallResult, compatibility);

    expect(result?.prependSystemContext).toBe("<user-persona>stable</user-persona>");
    expect(result?.prependContext).toBe("<relevant-memories>dynamic</relevant-memories>");
    expect(result?.appendContext).toBeUndefined();
  });

  it("keeps legacy stable placement when the host version is unknown", () => {
    const compatibility = resolveOpenClawRecallCompatibility("prepend", undefined);
    const result = shapeOpenClawRecallResult(recallResult, compatibility);

    expect(result?.appendSystemContext).toBe("<user-persona>stable</user-persona>");
    expect(result?.prependSystemContext).toBeUndefined();
  });

  it("returns undefined when there is no prompt context", () => {
    const compatibility = resolveOpenClawRecallCompatibility("prepend", "2026.4.27");
    expect(shapeOpenClawRecallResult({}, compatibility)).toBeUndefined();
    expect(shapeOpenClawRecallResult(undefined, compatibility)).toBeUndefined();
  });

  it("keeps the stable system shape byte-identical across five append-mode turns", () => {
    const compatibility = resolveOpenClawRecallCompatibility("append", "2026.5.28");
    const systemPrompts = new Set<string>();

    for (let turn = 1; turn <= 5; turn++) {
      const shaped = shapeOpenClawRecallResult(
        {
          appendSystemContext: "<user-persona>stable</user-persona>",
          prependContext: `<relevant-memories>turn-${turn}</relevant-memories>`,
        },
        compatibility,
      );

      const systemPrompt = [
        shaped?.prependSystemContext,
        "BASE SYSTEM PREFIX",
        "<!-- OPENCLAW_CACHE_BOUNDARY -->",
        "dynamic host suffix",
      ].join("\n");
      systemPrompts.add(systemPrompt);
      expect(shaped?.prependContext).toBeUndefined();
      expect(`question-${turn}\n\n${shaped?.appendContext}`).toMatch(
        new RegExp(`^question-${turn}`),
      );
    }

    expect(systemPrompts.size).toBe(1);
  });
});

