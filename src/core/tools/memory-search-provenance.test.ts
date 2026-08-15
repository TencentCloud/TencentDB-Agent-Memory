import { describe, expect, it } from "vitest";
import { executeMemorySearch, formatSearchResponse } from "./memory-search.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";

describe("memory search provenance output", () => {
  it("carries provenance metadata from FTS results into tool results", async () => {
    const ftsResult: L1FtsResult = {
      record_id: "rec-search",
      content: "User trusts records imported from the ticket system.",
      type: "instruction",
      priority: 90,
      scene_name: "support workflow",
      score: 0.91,
      timestamp_str: "",
      timestamp_start: "",
      timestamp_end: "",
      session_key: "session-a",
      session_id: "sid-a",
      metadata_json: JSON.stringify({
        source: "ticket-system",
        credibility_score: 0.74,
        namespace: "support",
      }),
    };

    const vectorStore = {
      isFtsAvailable: () => true,
      searchL1Fts: () => [ftsResult],
    } as unknown as IMemoryStore;

    const result = await executeMemorySearch({
      query: "ticket",
      limit: 1,
      vectorStore,
    });

    expect(result.results[0]).toMatchObject({
      source: "ticket-system",
      credibility_score: 0.74,
      namespace: "support",
    });

    const formatted = formatSearchResponse(result);
    expect(formatted).toContain("source: ticket-system");
    expect(formatted).toContain("credibility: 0.74");
    expect(formatted).toContain("namespace: support");
  });
});

