import { describe, expect, it } from "vitest";

import { mapRecallResultToOpenClawPromptBuild } from "./prompt-build.js";

describe("mapRecallResultToOpenClawPromptBuild", () => {
  it("places stable recall context before OpenClaw's cache boundary", () => {
    const mapped = mapRecallResultToOpenClawPromptBuild({
      appendSystemContext: "stable persona and scene context",
      prependContext: "dynamic memories before prompt",
      appendContext: "dynamic memories after prompt",
    });

    expect(mapped).toEqual({
      prependSystemContext: "stable persona and scene context",
      prependContext: "dynamic memories before prompt",
      appendContext: "dynamic memories after prompt",
    });
    expect(mapped).not.toHaveProperty("appendSystemContext");
  });

  it("returns undefined for empty recall results", () => {
    expect(mapRecallResultToOpenClawPromptBuild({})).toBeUndefined();
    expect(mapRecallResultToOpenClawPromptBuild(undefined)).toBeUndefined();
  });
});
