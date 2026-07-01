import { describe, expect, it } from "vitest";

import { mapRecallResultToOpenClawPromptBuild } from "./prompt-build.js";

describe("mapRecallResultToOpenClawPromptBuild", () => {
  it("places stable recall context before OpenClaw cache boundary via prependSystemContext", () => {
    const result = mapRecallResultToOpenClawPromptBuild({
      appendSystemContext: "<user-persona>\nstable\n</user-persona>",
      prependContext: "<relevant-memories>\ndynamic\n</relevant-memories>",
    });

    expect(result).toEqual({
      prependSystemContext: "<user-persona>\nstable\n</user-persona>",
      prependContext: "<relevant-memories>\ndynamic\n</relevant-memories>",
    });
    expect(result).not.toHaveProperty("appendSystemContext");
  });

  it("does not inject an empty hook result", () => {
    expect(mapRecallResultToOpenClawPromptBuild({})).toBeUndefined();
  });
});
