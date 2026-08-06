import { describe, expect, it } from "vitest";
import { mapRecallResultToOpenClawPromptBuild } from "./prompt-build.js";

describe("mapRecallResultToOpenClawPromptBuild", () => {
  it("returns stable recall through prependSystemContext", () => {
    const result = mapRecallResultToOpenClawPromptBuild({
      appendSystemContext: "<user-persona>stable</user-persona>",
      prependContext: "<relevant-memories>dynamic</relevant-memories>",
    });

    expect(result).toEqual({
      prependSystemContext: "<user-persona>stable</user-persona>",
      prependContext: "<relevant-memories>dynamic</relevant-memories>",
    });
    expect(result).not.toHaveProperty("appendSystemContext");
  });

  it("returns undefined when there is no prompt context", () => {
    expect(mapRecallResultToOpenClawPromptBuild(undefined)).toBeUndefined();
    expect(mapRecallResultToOpenClawPromptBuild({})).toBeUndefined();
  });
});
