import { describe, expect, it } from "vitest";
import { composeRecallPromptContext } from "./auto-recall.js";

describe("composeRecallPromptContext", () => {
  it("keeps recall-only hit and miss turns on the same stable system prefix", () => {
    const recallHit = composeRecallPromptContext({ memoryLines: ["- recalled memory"] });
    const recallMiss = composeRecallPromptContext({ memoryLines: [] });

    expect(recallHit.appendSystemContext).toBe(recallMiss.appendSystemContext);
    expect(recallHit.appendSystemContext).toContain("<memory-tools-guide>");
    expect(recallHit.prependContext).toContain("<memory-tdai-auto-recall>");
    expect(recallHit.prependContext).toContain("<relevant-memories>");
    expect(recallHit.prependContext).not.toContain("<memory-tools-guide>");
  });

  it("keeps the tools guide in stable system context when persona exists", () => {
    const recallHit = composeRecallPromptContext({
      memoryLines: ["- recalled memory"],
      personaContent: "User prefers concise answers.",
    });
    const recallMiss = composeRecallPromptContext({
      memoryLines: [],
      personaContent: "User prefers concise answers.",
    });

    expect(recallHit.appendSystemContext).toBe(recallMiss.appendSystemContext);
    expect(recallHit.appendSystemContext).toContain("<memory-tools-guide>");
    expect(recallHit.prependContext).not.toContain("<memory-tools-guide>");
  });
});
