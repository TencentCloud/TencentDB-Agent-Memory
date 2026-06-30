import { describe, expect, it } from "vitest";

import { buildRecallResponse } from "./server.js";

describe("Gateway recall response", () => {
  it("combines dynamic L1 context and stable system context for single-context clients", () => {
    const response = buildRecallResponse({
      prependContext: "<relevant-memories>\n- [instruction] mention ArgusCedar\n</relevant-memories>",
      appendSystemContext: "<memory-tools-guide>\nUse memory search when needed.\n</memory-tools-guide>",
      recallStrategy: "keyword",
      recalledL1Memories: [{ content: "mention ArgusCedar", score: 0, type: "instruction" }],
    });

    expect(response.context).toContain("<relevant-memories>");
    expect(response.context).toContain("ArgusCedar");
    expect(response.context).toContain("<memory-tools-guide>");
    expect(response.prepend_context).toContain("ArgusCedar");
    expect(response.append_system_context).toContain("memory-tools-guide");
    expect(response.strategy).toBe("keyword");
    expect(response.memory_count).toBe(1);
  });
});
