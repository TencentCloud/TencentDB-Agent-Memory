import { describe, expect, it } from "vitest";
import { mapRecallResultToOpenClawPromptBuild } from "./prompt-build.js";

describe("mapRecallResultToOpenClawPromptBuild", () => {
  it("keeps stable recall context before the OpenClaw cache boundary", () => {
    expect(mapRecallResultToOpenClawPromptBuild({
      appendSystemContext: "<user-persona>stable</user-persona>",
      prependContext: "<memory-tdai-auto-recall>dynamic</memory-tdai-auto-recall>",
      recalledL1Memories: [{ content: "memory", score: 0.9, type: "fact" }],
    })).toEqual({
      prependSystemContext: "<user-persona>stable</user-persona>",
      prependContext: "<memory-tdai-auto-recall>dynamic</memory-tdai-auto-recall>",
    });
  });

  it("does not return an empty hook result", () => {
    expect(mapRecallResultToOpenClawPromptBuild({})).toBeUndefined();
  });
});
