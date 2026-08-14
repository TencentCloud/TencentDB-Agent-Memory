import { describe, expect, it } from "vitest";

import { buildRecallResponse } from "./server.js";

describe("buildRecallResponse", () => {
  it("exposes both dynamic L1 memories and stable recall context", () => {
    const response = buildRecallResponse({
      prependContext: "<relevant-memories>\n- [instruction] codex marker\n</relevant-memories>",
      appendSystemContext: "<user-persona>\nproject persona\n</user-persona>",
      recallStrategy: "hybrid",
      recalledL1Memories: [{ content: "codex marker", score: 0, type: "instruction" }],
    });

    expect(response.context).toContain("codex marker");
    expect(response.context).toContain("project persona");
    expect(response.prepend_context).toContain("codex marker");
    expect(response.append_context).toContain("project persona");
    expect(response.memory_count).toBe(1);
    expect(response.strategy).toBe("hybrid");
  });
});
