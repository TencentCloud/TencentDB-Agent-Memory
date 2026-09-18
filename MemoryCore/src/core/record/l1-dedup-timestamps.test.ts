import { describe, expect, it } from "vitest";
import { formatExtractionPrompt } from "../prompts/l1-extraction.js";
import { formatBatchConflictPrompt, type CandidateMatch } from "../prompts/l1-dedup.js";
import { applyDedupProvenance } from "./l1-dedup.js";
import { epochMsToIso, resolveSourceTimestamps, timestampsForWrite, timestampsFromSearchHit } from "./l1-timestamps.js";
import { normalizeDedupDecisionForWrite, type DedupDecision, type ExtractedMemory, type MemoryRecord } from "./l1-writer.js";
import type { Logger } from "../types.js";

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

  it("skips out-of-range epoch values instead of throwing", () => {
    expect(() =>
      resolveSourceTimestamps(["m"], [{ id: "m", timestamp: 1e20 }]),
    ).not.toThrow();
    expect(resolveSourceTimestamps(["m"], [{ id: "m", timestamp: 1e20 }])).toEqual([]);
  });

  it("keeps valid timestamps when mixed with out-of-range values", () => {
    const iso = resolveSourceTimestamps(
      ["good", "bad"],
      [
        { id: "good", timestamp: Date.parse(newTime) },
        { id: "bad", timestamp: 1e20 },
      ],
    );
    expect(iso).toEqual([newTime]);
  });

  it("skips negative out-of-range epoch values", () => {
    expect(resolveSourceTimestamps(["m"], [{ id: "m", timestamp: -1e20 }])).toEqual([]);
  });
});

describe("epochMsToIso", () => {
  it("converts in-range epoch ms and skips out-of-range values", () => {
    expect(epochMsToIso(Date.parse(newTime))).toBe(newTime);
    expect(epochMsToIso(1e20)).toBeUndefined();
    expect(epochMsToIso(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("formatExtractionPrompt — out-of-range timestamps", () => {
  it("does not throw when a message timestamp is out of range", () => {
    expect(() =>
      formatExtractionPrompt({
        newMessages: [{ id: "m", role: "user", content: "hi", timestamp: 1e20 }],
        backgroundMessages: [{ id: "b", role: "assistant", content: "ok", timestamp: -1e20 }],
      }),
    ).not.toThrow();
  });

  it("keeps message text and omits unconvertible timestamps", () => {
    const prompt = formatExtractionPrompt({
      newMessages: [{ id: "m", role: "user", content: "hi", timestamp: 1e20 }],
      backgroundMessages: [{ id: "b", role: "assistant", content: "ok", timestamp: -1e20 }],
    });
    expect(prompt).toContain("hi");
    expect(prompt).toContain("ok");
    expect(prompt).not.toContain(String(1e20));
    expect(prompt).not.toContain(String(-1e20));
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
      merged_content: "Use UTC for reports.",
      merged_timestamps: [inventedTime],
    }];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out.action).toBe("update");
    expect(out.target_ids).toEqual(["old-1"]);
    expect(out.merged_content).toBe("Use UTC for reports.");
    expect(out.merged_timestamps).toEqual([oldTime, newTime]);
    expect(out.merged_timestamps).not.toContain(inventedTime);
  });

  it("keeps candidate start and end times in the merge union", () => {
    const endTime = "2026-09-09T12:00:00.000Z";
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1" }),
      candidates: [candidate("old-1", timestampsFromSearchHit({
        timestamp_str: oldTime,
        timestamp_start: oldTime,
        timestamp_end: endTime,
      }))],
    }];
    const decisions: DedupDecision[] = [{
      record_id: "new-1",
      action: "merge",
      target_ids: ["old-1"],
      merged_content: "Use UTC for reports.",
    }];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out.merged_timestamps).toEqual([oldTime, newTime, endTime]);
  });
});

describe("applyDedupProvenance — missing provenance falls back to store", () => {
  it("stores the original memory when new timestamps are empty", () => {
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1", timestamps: [] }),
      candidates: [candidate("old-1", [oldTime])],
    }];
    const decisions: DedupDecision[] = [{
      record_id: "new-1",
      action: "merge",
      target_ids: ["old-1"],
      merged_content: "Use UTC; previously local time.",
      merged_type: "instruction",
      merged_priority: 90,
    }];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out).toEqual({ record_id: "new-1", action: "store", target_ids: [] });
  });

  it("stores the original memory when both new and candidate timestamps are empty", () => {
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1", timestamps: [] }),
      candidates: [candidate("old-1", [])],
    }];
    const decisions: DedupDecision[] = [{
      record_id: "new-1",
      action: "update",
      target_ids: ["old-1"],
      merged_content: "Use UTC for reports.",
    }];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out).toEqual({ record_id: "new-1", action: "store", target_ids: [] });
  });
});

describe("applyDedupProvenance — invalid targets fall back to store", () => {
  it("stores original content when every target is outside the candidate pool", () => {
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1" }),
      candidates: [candidate("old-1", [oldTime])],
    }];
    const decisions: DedupDecision[] = [{
      record_id: "new-1",
      action: "merge",
      target_ids: ["not-in-pool"],
      merged_content: "Merged with a hallucinated record.",
      merged_type: "instruction",
      merged_priority: 90,
    }];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out).toEqual({ record_id: "new-1", action: "store", target_ids: [] });
  });

  it("stores original content when targets mix valid and invalid ids", () => {
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1" }),
      candidates: [candidate("old-1", [oldTime])],
    }];
    const decisions: DedupDecision[] = [{
      record_id: "new-1",
      action: "update",
      target_ids: ["old-1", "not-in-pool"],
      merged_content: "Combined valid and invalid targets.",
    }];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out).toEqual({ record_id: "new-1", action: "store", target_ids: [] });
  });

  it("stores original content when merge lists no targets", () => {
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1" }),
      candidates: [candidate("old-1", [oldTime])],
    }];
    const decisions: DedupDecision[] = [{
      record_id: "new-1",
      action: "merge",
      target_ids: [],
      merged_content: "Merged with nobody.",
    }];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out).toEqual({ record_id: "new-1", action: "store", target_ids: [] });
  });

  it("ignores blank target ids instead of treating them as mixed", () => {
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1" }),
      candidates: [candidate("old-1", [oldTime])],
    }];
    const decisions: DedupDecision[] = [{
      record_id: "new-1",
      action: "update",
      target_ids: ["old-1", "", "  "],
      merged_content: "Use UTC for reports.",
    }];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out.action).toBe("update");
    expect(out.target_ids).toEqual(["old-1"]);
    expect(out.merged_content).toBe("Use UTC for reports.");
  });
});

describe("applyDedupProvenance — skip is unchanged", () => {
  it("keeps skip when source timestamps are empty", () => {
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1", timestamps: [] }),
      candidates: [candidate("old-1", [oldTime])],
    }];
    const decisions: DedupDecision[] = [{
      record_id: "new-1",
      action: "skip",
      target_ids: ["old-1"],
    }];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out.action).toBe("skip");
    expect(out.target_ids).toEqual(["old-1"]);
  });
});

describe("applyDedupProvenance — fallback logging", () => {
  it("warns with a reason when merge/update falls back to store", () => {
    const warnings: string[] = [];
    const logger: Logger = {
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
    };
    const matches: CandidateMatch[] = [{
      newMemory: newMemory({ record_id: "new-1" }),
      candidates: [candidate("old-1", [oldTime])],
    }];
    const decisions: DedupDecision[] = [{
      record_id: "new-1",
      action: "update",
      target_ids: ["old-1", "not-in-pool"],
    }];

    applyDedupProvenance(decisions, matches, logger);
    expect(warnings).toEqual([
      "[memory-tdai][l1-dedup] Falling back to store for new-1 (update → store, reason=mixed_targets)",
    ]);
  });
});

describe("normalizeDedupDecisionForWrite", () => {
  it("stores original memory when merge/update has no timestamps", () => {
    const out = normalizeDedupDecisionForWrite(
      {
        record_id: "new-1",
        action: "merge",
        target_ids: ["old-1"],
        merged_content: "Do not persist this.",
      },
      newMemory({ record_id: "new-1", timestamps: [] }),
    );
    expect(out).toEqual({ record_id: "new-1", action: "store", target_ids: [] });
  });

  it("stores original memory when source timestamps are empty even if merged_timestamps are present", () => {
    const out = normalizeDedupDecisionForWrite(
      {
        record_id: "new-1",
        action: "merge",
        target_ids: ["old-1"],
        merged_content: "Do not persist this.",
        merged_timestamps: [oldTime],
      },
      newMemory({ record_id: "new-1", timestamps: [] }),
    );
    expect(out).toEqual({ record_id: "new-1", action: "store", target_ids: [] });
  });

  it("stores original memory when merge/update lists no targets", () => {
    const out = normalizeDedupDecisionForWrite(
      {
        record_id: "new-1",
        action: "update",
        target_ids: ["", "  "],
        merged_content: "Do not persist this.",
      },
      newMemory({ record_id: "new-1" }),
    );
    expect(out).toEqual({ record_id: "new-1", action: "store", target_ids: [] });
  });

  it("keeps merge/update when timestamps and targets are present", () => {
    const decision: DedupDecision = {
      record_id: "new-1",
      action: "update",
      target_ids: ["old-1"],
      merged_content: "Use UTC for reports.",
      merged_timestamps: [oldTime, newTime],
    };
    expect(normalizeDedupDecisionForWrite(decision, newMemory({ record_id: "new-1" }))).toEqual(decision);
  });

  it("strips blank target ids without falling back to store", () => {
    const out = normalizeDedupDecisionForWrite(
      {
        record_id: "new-1",
        action: "update",
        target_ids: ["old-1", ""],
        merged_content: "Use UTC for reports.",
        merged_timestamps: [oldTime, newTime],
      },
      newMemory({ record_id: "new-1" }),
    );
    expect(out.action).toBe("update");
    expect(out.target_ids).toEqual(["old-1"]);
    expect(out.merged_content).toBe("Use UTC for reports.");
  });

  it("does not change skip", () => {
    const decision: DedupDecision = {
      record_id: "new-1",
      action: "skip",
      target_ids: ["old-1"],
    };
    expect(normalizeDedupDecisionForWrite(decision, newMemory({ record_id: "new-1", timestamps: [] }))).toEqual(decision);
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

  it("does not stamp processing time on merge/update when provenance is empty", () => {
    expect(timestampsForWrite({
      action: "merge",
      memoryTimestamps: [],
      mergedTimestamps: [],
      nowIso,
    })).toEqual([]);
    expect(timestampsForWrite({
      action: "update",
      memoryTimestamps: [],
      mergedTimestamps: ["not-a-date"],
      nowIso,
    })).toEqual([]);
  });

  it("does not persist an empty or omitted nowIso on store", () => {
    expect(timestampsForWrite({
      action: "store",
      memoryTimestamps: [],
    })).toEqual([]);
    expect(timestampsForWrite({
      action: "store",
      memoryTimestamps: [],
      nowIso: "",
    })).toEqual([]);
  });
});

describe("timestampsFromSearchHit", () => {
  const endTime = "2026-09-09T12:00:00.000Z";

  it("unions str/start/end so recall does not drop the latest evidence time", () => {
    expect(timestampsFromSearchHit({
      timestamp_str: oldTime,
      timestamp_start: oldTime,
      timestamp_end: endTime,
    })).toEqual([oldTime, endTime]);
  });

  it("dedupes when str/start/end are the same instant", () => {
    expect(timestampsFromSearchHit({
      timestamp_str: oldTime,
      timestamp_start: oldTime,
      timestamp_end: oldTime,
    })).toEqual([oldTime]);
  });

  it("skips empty and unparseable fields", () => {
    expect(timestampsFromSearchHit({
      timestamp_str: "",
      timestamp_start: "not-a-date",
      timestamp_end: newTime,
    })).toEqual([newTime]);
  });
});
