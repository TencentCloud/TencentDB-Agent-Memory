import { describe, expect, it } from "vitest";
import {
  analyzeStableContextStability,
  composeStableSystemContext,
} from "./recall-stable-context.js";

const GUIDE = "<memory-tools-guide>guide</memory-tools-guide>";

describe("composeStableSystemContext", () => {
  it("returns undefined when there is no stable content", () => {
    expect(composeStableSystemContext({}, { toolsGuide: GUIDE })).toBeUndefined();
  });

  it("wraps persona and scene, then appends the tools guide", () => {
    const result = composeStableSystemContext(
      { personaContent: "P", sceneNavigation: "S" },
      { toolsGuide: GUIDE },
    );
    expect(result).toBe(
      `<user-persona>\nP\n</user-persona>\n\n<scene-navigation>\nS\n</scene-navigation>\n\n${GUIDE}`,
    );
  });

  it("attaches the guide to persona-only stable content", () => {
    expect(composeStableSystemContext({ personaContent: "P" }, { toolsGuide: GUIDE }))
      .toBe(`<user-persona>\nP\n</user-persona>\n\n${GUIDE}`);
  });

  it("is byte-identical for identical stable inputs (cacheable)", () => {
    const a = composeStableSystemContext({ personaContent: "P", sceneNavigation: "S" }, { toolsGuide: GUIDE });
    const b = composeStableSystemContext({ personaContent: "P", sceneNavigation: "S" }, { toolsGuide: GUIDE });
    expect(a).toBe(b);
  });

  it("does NOT depend on per-turn dynamic recall — persona present means stable region is constant", () => {
    // Same persona across turns → identical system region regardless of whether
    // this turn matched any dynamic L1 memory.
    const turnWithMemories = composeStableSystemContext({ personaContent: "P" }, { toolsGuide: GUIDE });
    const turnWithoutMemories = composeStableSystemContext({ personaContent: "P" }, { toolsGuide: GUIDE });
    expect(turnWithMemories).toBe(turnWithoutMemories);
  });
});

describe("analyzeStableContextStability", () => {
  it("counts zero changes when the region is constant across turns", () => {
    const block = composeStableSystemContext({ personaContent: "P" }, { toolsGuide: GUIDE });
    const result = analyzeStableContextStability([block, block, block, block]);
    expect(result.changeCount).toBe(0);
    expect(result.changedPerTurn).toEqual([false, false, false, false]);
  });

  it("detects the old flip: guide appears only on turns that matched a memory", () => {
    // Reproduces the pre-fix behavior for a persona-less user: the stable region
    // flipped between the guide and empty depending on per-turn dynamic recall.
    const oldRegionPerTurn = [GUIDE, undefined, GUIDE, undefined];
    const result = analyzeStableContextStability(oldRegionPerTurn);
    expect(result.changeCount).toBe(3);
  });
});
