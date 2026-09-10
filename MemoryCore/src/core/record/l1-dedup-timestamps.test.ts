import { describe, expect, it } from "vitest";
import { formatBatchConflictPrompt, type CandidateMatch } from "../prompts/l1-dedup.js";
import { applyDedupProvenance } from "./l1-dedup.js";
import { resolveSourceTimestamps, timestampsForWrite } from "./l1-timestamps.js";
import type { DedupDecision, ExtractedMemory, MemoryRecord } from "./l1-writer.js";

const oldTime = "2026-09-08T04:00:00.000Z";
const newTime = "2026-09-09T04:00:00.000Z";
const inventedTime = "2099-01-01T00:00:00.000Z";

function newMemory(overrides: Partial<ExtractedMemory> & { record_id: string }): ExtractedMemory & { record_id: string } {
  return {
    content: "Use UTC for reports.",
    type: "instruction",
    priority: 70,
    source_message_ids: ["msg-1"],
    metadata: {},
    scene_name: "Reporting",
    timestamps: [newTime],
    ...overrides,
  };
}

function candidate(id: string, timestamps: string[]): MemoryRecord {
  return {
    id,
    content: "Use local time for reports.",
    type: "instruction",
    priority: 70,
    source_message_ids: [],
    metadata: {},
    scene_name: "Reporting",
    timestamps,
    createdAt: oldTime,
    updatedAt: oldTime,
    sessionKey: "example",
    sessionId: "example",
  };
}

describe("formatBatchConflictPrompt — new-memory timestamps", () => {
  it("includes new-memory source timestamps alongside candidate timestamps", () => {
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1" }),
      candidates: [candidate("old-1", [oldTime])],
    }];

    const prompt = formatBatchConflictPrompt(matches);
    expect(prompt.includes(oldTime)).toBe(true);
    expect(prompt.includes(newTime)).toBe(true);
  });

  it("does not invent timestamps that are not on the new memory or candidates", () => {
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1" }),
      candidates: [candidate("old-1", [oldTime])],
    }];

    const prompt = formatBatchConflictPrompt(matches);
    expect(prompt.includes(inventedTime)).toBe(false);
  });
});

describe("resolveSourceTimestamps", () => {
  it("converts matching source_message_ids from epoch ms to ISO", () => {
    const iso = resolveSourceTimestamps(
      ["msg-1"],
      [{ id: "msg-1", timestamp: Date.parse(newTime) }],
    );
    expect(iso).toEqual([newTime]);
  });

  it("skips unresolved ids instead of falling back to every scene message", () => {
    const iso = resolveSourceTimestamps(
      ["missing"],
      [
        { id: "msg-1", timestamp: Date.parse(oldTime) },
        { id: "msg-2", timestamp: Date.parse(newTime) },
      ],
    );
    expect(iso).toEqual([]);
  });

  it("keeps only the resolved subset when some source ids are missing", () => {
    const iso = resolveSourceTimestamps(
      ["msg-1", "missing"],
      [{ id: "msg-1", timestamp: Date.parse(newTime) }],
    );
    expect(iso).toEqual([newTime]);
  });
});

describe("applyDedupProvenance — timestamp union", () => {
  it("unions new-memory timestamps with selected candidate timestamps", () => {
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1" }),
      candidates: [candidate("old-1", [oldTime])],
    }];
    const decisions: DedupDecision[] = [{
      record_id: "new-1",
      action: "update",
      target_ids: ["old-1"],
      merged_timestamps: [inventedTime],
    }];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out.merged_timestamps).toEqual([oldTime, newTime]);
    expect(out.merged_timestamps).not.toContain(inventedTime);
  });

  it("drops hallucinated target_ids outside the unified candidate pool", () => {
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1" }),
      candidates: [candidate("old-1", [oldTime])],
    }];
    const decisions: DedupDecision[] = [{
      record_id: "new-1",
      action: "merge",
      target_ids: ["old-1", "not-in-pool"],
    }];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out.target_ids).toEqual(["old-1"]);
    expect(out.merged_timestamps).toEqual([oldTime, newTime]);
  });
});

describe("timestampsForWrite", () => {
  const nowIso = "2026-09-10T00:00:00.000Z";

  it("uses the code-computed union for merge/update", () => {
    expect(timestampsForWrite({
      action: "update",
      memoryTimestamps: [newTime],
      mergedTimestamps: [oldTime, newTime],
      nowIso,
    })).toEqual([oldTime, newTime]);
  });

  it("drops unparseable merged timestamps and falls back to source timestamps", () => {
    expect(timestampsForWrite({
      action: "merge",
      memoryTimestamps: [newTime],
      mergedTimestamps: ["not-a-date", ""],
      nowIso,
    })).toEqual([newTime]);
  });

  it("falls back to processing time for store when no source timestamps resolved", () => {
    expect(timestampsForWrite({
      action: "store",
      memoryTimestamps: [],
      nowIso,
    })).toEqual([nowIso]);
  });

  it("persists source timestamps on store when they resolved", () => {
    expect(timestampsForWrite({
      action: "store",
      memoryTimestamps: [newTime],
      nowIso,
    })).toEqual([newTime]);
  });
});
