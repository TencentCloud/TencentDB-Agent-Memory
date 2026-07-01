import { describe, expect, it } from "vitest";

import { buildCaptureTurn, buildRecallResponse } from "./server.js";

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

describe("Gateway capture request normalization", () => {
  it("adds monotonic timestamps when HTTP clients omit raw messages", () => {
    const turn = buildCaptureTurn({
      user_content: "remember the Hermes issue marker",
      assistant_content: "acknowledged",
      session_key: "session-1",
    }, 1_000);

    expect(turn.startedAt).toBe(1_000);
    expect(turn.messages).toEqual([
      { role: "user", content: "remember the Hermes issue marker", timestamp: 1_001 },
      { role: "assistant", content: "acknowledged", timestamp: 1_002 },
    ]);
  });

  it("keeps client-provided messages unchanged", () => {
    const messages = [
      { role: "user", content: "original", timestamp: 2_000 },
      { role: "assistant", content: "reply", timestamp: 2_100 },
    ];

    const turn = buildCaptureTurn({
      user_content: "fallback user",
      assistant_content: "fallback assistant",
      session_key: "session-1",
      messages,
    }, 1_000);

    expect(turn.startedAt).toBe(1_000);
    expect(turn.messages).toBe(messages);
  });
});
