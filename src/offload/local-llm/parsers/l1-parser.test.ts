import { describe, it, expect } from "vitest";
import { parseL1Response } from "./l1-parser.js";

describe("L1 Response Parser", () => {
  it("should parse L1 entries correctly and ensure result_ref is present", () => {
    const raw = JSON.stringify([
      {
        tool_call: "read_file({path: 'foo.ts'})",
        summary: "Reads content of foo.ts",
        tool_call_id: "call_abc123",
        timestamp: "2026-07-11T12:00:00Z",
        score: 8,
      },
    ]);

    const entries = parseL1Response(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      tool_call_id: "call_abc123",
      tool_call: "read_file({path: 'foo.ts'})",
      summary: "Reads content of foo.ts",
      timestamp: "2026-07-11T12:00:00Z",
      score: 8,
      node_id: null,
      result_ref: "",
    });
  });

  it("should ignore entries with empty tool_call_id", () => {
    const raw = JSON.stringify([
      {
        tool_call: "read_file({path: 'foo.ts'})",
        summary: "Reads content of foo.ts",
        timestamp: "2026-07-11T12:00:00Z",
      },
    ]);

    const entries = parseL1Response(raw);
    expect(entries).toHaveLength(0);
  });
});
