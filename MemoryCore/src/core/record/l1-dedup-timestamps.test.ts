import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CandidateMatch } from "../prompts/l1-dedup.js";
import { applyDedupProvenance, batchDedup } from "./l1-dedup.js";
import { extractL1Memories } from "./l1-extractor.js";
import { timestampsForWrite, timestampsFromSearchHit, uniqueSortedTimestamps } from "./l1-timestamps.js";
import {
  normalizeDedupDecisionForWrite,
  writeMemory,
  type DedupDecision,
  type ExtractedMemory,
  type MemoryRecord,
} from "./l1-writer.js";
import { VectorStore } from "../store/sqlite/memory-store.js";
import type { Logger } from "../types.js";

const t1 = "2026-09-08T04:00:00.000Z";
const t2 = "2026-09-09T04:00:00.000Z";
const t3 = "2026-09-10T04:00:00.000Z";
const inventedTime = "2099-01-01T00:00:00.000Z";

function newMemory(
  overrides: Partial<ExtractedMemory> & { record_id: string },
): ExtractedMemory & { record_id: string } {
  return {
    content: "Use UTC for reports.",
    type: "instruction",
    priority: 70,
    source_message_ids: ["msg-1"],
    metadata: {},
    scene_name: "Reporting",
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
    createdAt: t1,
    updatedAt: t1,
    sessionKey: "session-1",
    sessionId: "session-1",
  };
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "l1-dedup-ts-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("store receives the current write time", () => {
  it("timestampsForWrite returns [nowIso] for store", () => {
    expect(
      timestampsForWrite({
        action: "store",
        nowIso: t1,
      }),
    ).toEqual([t1]);
  });

  it("writeMemory persists [now] on store", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(t1));
    const baseDir = await makeTempDir();

    const record = await writeMemory({
      memory: newMemory({ record_id: "rec-1" }),
      decision: {
        record_id: "rec-1",
        action: "store",
        target_ids: [],
      },
      baseDir,
      sessionKey: "session-1",
      sessionId: "session-1",
    });

    expect(record).not.toBeNull();
    expect(record!.timestamps).toEqual([t1]);
  });
});

describe("single-target and multi-target merge/update preserve old timestamps and add current write time", () => {
  it("single-target update preserves target timestamps and adds current write time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(t2));
    const baseDir = await makeTempDir();

    const matches: CandidateMatch[] = [
      {
        newMemory: newMemory({ record_id: "new-1" }),
        candidates: [candidate("old-1", [t1])],
      },
    ];
    const [decision] = applyDedupProvenance(
      [
        {
          record_id: "new-1",
          action: "update",
          target_ids: ["old-1"],
          merged_content: "Use UTC for all reports.",
          merged_type: "instruction",
          merged_priority: 85,
        },
      ],
      matches,
    );

    expect(decision.merged_timestamps).toEqual([t1]);

    const record = await writeMemory({
      memory: newMemory({ record_id: "new-1" }),
      decision,
      baseDir,
      sessionKey: "session-1",
      sessionId: "session-1",
    });

    expect(record).not.toBeNull();
    expect(record!.timestamps).toEqual([t1, t2]);
    expect(record!.content).toBe("Use UTC for all reports.");
  });

  it("multi-target merge unions, de-duplicates, and sorts all selected target timestamps with current write time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(t3));
    const baseDir = await makeTempDir();

    const matches: CandidateMatch[] = [
      {
        newMemory: newMemory({ record_id: "new-1" }),
        candidates: [
          candidate("old-2", [t2]),
          candidate("old-1", [t1, t2]),
          candidate("unselected", ["2026-09-01T00:00:00.000Z"]),
        ],
      },
    ];
    const [decision] = applyDedupProvenance(
      [
        {
          record_id: "new-1",
          action: "merge",
          target_ids: ["old-2", "old-1"],
          merged_content: "Use UTC for daily and weekly reports.",
          merged_type: "instruction",
          merged_priority: 90,
        },
      ],
      matches,
    );

    expect(decision.merged_timestamps).toEqual([t1, t2]);

    const record = await writeMemory({
      memory: newMemory({ record_id: "new-1" }),
      decision,
      baseDir,
      sessionKey: "session-1",
      sessionId: "session-1",
    });

    expect(record).not.toBeNull();
    expect(record!.timestamps).toEqual([t1, t2, t3]);
  });

  it("timestampsFromSearchHit preserves start and end bounds across repeated merges", () => {
    expect(
      timestampsFromSearchHit({
        timestamp_str: t1,
        timestamp_start: t1,
        timestamp_end: t2,
      }),
    ).toEqual([t1, t2]);

    expect(
      timestampsForWrite({
        action: "merge",
        mergedTimestamps: timestampsFromSearchHit({
          timestamp_str: t1,
          timestamp_start: t1,
          timestamp_end: t2,
        }),
        nowIso: t3,
      }),
    ).toEqual([t1, t2, t3]);
  });
});

describe("invented model timestamps are ignored", () => {
  it("applyDedupProvenance discards model-supplied merged_timestamps on merge/update and store", () => {
    const matches: CandidateMatch[] = [
      {
        newMemory: newMemory({ record_id: "new-1" }),
        candidates: [candidate("old-1", [t1])],
      },
      {
        newMemory: newMemory({ record_id: "new-2" }),
        candidates: [candidate("old-1", [t1])],
      },
    ];
    const decisions: DedupDecision[] = [
      {
        record_id: "new-1",
        action: "update",
        target_ids: ["old-1"],
        merged_content: "Use UTC for reports.",
        merged_timestamps: [inventedTime],
      },
      {
        record_id: "new-2",
        action: "store",
        target_ids: [],
        merged_timestamps: [inventedTime],
      },
    ];

    const [updated, stored] = applyDedupProvenance(decisions, matches);
    expect(updated.merged_timestamps).toEqual([t1]);
    expect(updated.merged_timestamps).not.toContain(inventedTime);
    expect(stored.merged_timestamps).toBeUndefined();
  });

  it("batchDedup ignores merged_timestamps in raw LLM JSON output", async () => {
    const baseDir = await makeTempDir();
    const store = new VectorStore(path.join(baseDir, "vectors.db"), 0);
    store.init();

    try {
      store.upsertL1(
        {
          ...candidate("old-1", [t1]),
          content: "Use local time for reports.",
        },
        undefined,
      );

      const decisions = await batchDedup({
        memories: [newMemory({ record_id: "new-1", content: "Use local time for reports." })],
        config: {},
        vectorStore: store,
        llmRunner: {
          run: async () =>
            JSON.stringify([
              {
                record_id: "new-1",
                action: "merge",
                target_ids: ["old-1"],
                merged_content: "Use UTC for reports (previously local time).",
                merged_type: "instruction",
                merged_priority: 85,
                merged_timestamps: [inventedTime],
              },
            ]),
        },
      });

      expect(decisions).toHaveLength(1);
      expect(decisions[0].action).toBe("merge");
      expect(decisions[0].merged_timestamps).toEqual([t1]);
      expect(decisions[0].merged_timestamps).not.toContain(inventedTime);
    } finally {
      store.close();
    }
  });
});

describe("missing source_message_ids does not block merge/update", () => {
  it("applyDedupProvenance and writeMemory keep merge/update when source_message_ids is empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(t2));
    const baseDir = await makeTempDir();

    const memWithoutSources = newMemory({
      record_id: "new-1",
      source_message_ids: [],
    });
    const matches: CandidateMatch[] = [
      {
        newMemory: memWithoutSources,
        candidates: [candidate("old-1", [t1])],
      },
    ];

    const [decision] = applyDedupProvenance(
      [
        {
          record_id: "new-1",
          action: "merge",
          target_ids: ["old-1"],
          merged_content: "Use UTC for reports.",
          merged_type: "instruction",
          merged_priority: 88,
        },
      ],
      matches,
    );

    expect(decision.action).toBe("merge");
    expect(decision.target_ids).toEqual(["old-1"]);
    expect(decision.merged_timestamps).toEqual([t1]);

    const normalized = normalizeDedupDecisionForWrite(decision, memWithoutSources);
    expect(normalized.action).toBe("merge");

    const record = await writeMemory({
      memory: memWithoutSources,
      decision,
      baseDir,
      sessionKey: "session-1",
      sessionId: "session-1",
    });

    expect(record).not.toBeNull();
    expect(record!.content).toBe("Use UTC for reports.");
    expect(record!.priority).toBe(88);
    expect(record!.timestamps).toEqual([t1, t2]);
  });

  it("extractL1Memories completes merge when LLM omits source_message_ids", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(t2));
    const baseDir = await makeTempDir();
    const store = new VectorStore(path.join(baseDir, "vectors.db"), 0);
    store.init();

    try {
      store.upsertL1(
        {
          ...candidate("old-1", [t1]),
          content: "User prefers UTC for weekly status reports.",
        },
        undefined,
      );

      const result = await extractL1Memories({
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Please always use UTC for weekly status reports and monthly summaries.",
            timestamp: Date.parse("2026-09-01T00:00:00.000Z"),
          },
        ],
        sessionKey: "session-1",
        sessionId: "session-1",
        baseDir,
        config: {},
        options: {
          vectorStore: store,
          llmRunner: {
            run: async ({ taskId, prompt }) => {
              if (taskId === "l1-extraction") {
                return JSON.stringify([
                  {
                    scene_name: "Reporting preferences",
                    message_ids: ["msg-1"],
                    memories: [
                      {
                        content: "User prefers UTC for weekly status reports and monthly summaries.",
                        type: "instruction",
                        priority: 85,
                        source_message_ids: [],
                        metadata: {},
                      },
                    ],
                  },
                ]);
              }
              const recordIdMatch = /record_id:\s*(m_[^\s)]+)/.exec(prompt);
              const newRecordId = recordIdMatch?.[1] ?? "";
              return JSON.stringify([
                {
                  record_id: newRecordId,
                  action: "merge",
                  target_ids: ["old-1"],
                  merged_content: "User requires UTC for weekly status reports and monthly summaries.",
                  merged_type: "instruction",
                  merged_priority: 90,
                  merged_timestamps: [inventedTime],
                },
              ]);
            },
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.storedCount).toBe(1);
      expect(result.records[0].content).toBe(
        "User requires UTC for weekly status reports and monthly summaries.",
      );
      expect(result.records[0].timestamps).toEqual([t1, t2]);
    } finally {
      store.close();
    }
  });
});

describe("SQLite timestamp_str, timestamp_start, and timestamp_end persistence", () => {
  it("persists expected SQLite timestamp columns across store, single-target update, and multi-target merge", async () => {
    const baseDir = await makeTempDir();
    const store = new VectorStore(path.join(baseDir, "vectors.db"), 0);
    store.init();

    try {
      vi.useFakeTimers();

      // 1. Store rec-1 at t1
      vi.setSystemTime(new Date(t1));
      const rec1 = await writeMemory({
        memory: newMemory({ record_id: "rec-1", content: "First memory" }),
        decision: { record_id: "rec-1", action: "store", target_ids: [] },
        baseDir,
        sessionKey: "session-1",
        sessionId: "session-1",
        vectorStore: store,
      });
      expect(rec1!.timestamps).toEqual([t1]);

      let rows = store.queryL1Records({ sessionId: "session-1" });
      expect(rows.map((r) => r.record_id)).toEqual(["rec-1"]);
      expect(rows[0].timestamp_str).toBe(t1);
      expect(rows[0].timestamp_start).toBe(t1);
      expect(rows[0].timestamp_end).toBe(t1);

      // 2. Single-target update rec-1 -> rec-2 at t2
      vi.setSystemTime(new Date(t2));
      const [updateDecision] = applyDedupProvenance(
        [
          {
            record_id: "rec-2",
            action: "update",
            target_ids: ["rec-1"],
            merged_content: "Updated first memory",
          },
        ],
        [
          {
            newMemory: newMemory({ record_id: "rec-2" }),
            candidates: [candidate("rec-1", timestampsFromSearchHit(rows[0]))],
          },
        ],
      );
      const rec2 = await writeMemory({
        memory: newMemory({ record_id: "rec-2", content: "Second memory" }),
        decision: updateDecision,
        baseDir,
        sessionKey: "session-1",
        sessionId: "session-1",
        vectorStore: store,
      });
      expect(rec2!.timestamps).toEqual([t1, t2]);

      rows = store.queryL1Records({ sessionId: "session-1" });
      expect(rows.map((r) => r.record_id)).toEqual(["rec-2"]);
      expect(rows[0].timestamp_str).toBe(t1);
      expect(rows[0].timestamp_start).toBe(t1);
      expect(rows[0].timestamp_end).toBe(t2);

      // 3. Store another independent record rec-extra at t2, then multi-target merge [rec-2, rec-extra] -> rec-3 at t3
      await writeMemory({
        memory: newMemory({ record_id: "rec-extra", content: "Extra memory" }),
        decision: { record_id: "rec-extra", action: "store", target_ids: [] },
        baseDir,
        sessionKey: "session-1",
        sessionId: "session-1",
        vectorStore: store,
      });
      const extraRow = store
        .queryL1Records({ sessionId: "session-1" })
        .find((r) => r.record_id === "rec-extra")!;

      vi.setSystemTime(new Date(t3));
      const [mergeDecision] = applyDedupProvenance(
        [
          {
            record_id: "rec-3",
            action: "merge",
            target_ids: ["rec-extra", "rec-2"],
            merged_content: "Merged memory across three writes",
          },
        ],
        [
          {
            newMemory: newMemory({ record_id: "rec-3" }),
            candidates: [
              candidate("rec-extra", timestampsFromSearchHit(extraRow)),
              candidate("rec-2", timestampsFromSearchHit(rows[0])),
            ],
          },
        ],
      );
      const rec3 = await writeMemory({
        memory: newMemory({ record_id: "rec-3", content: "Third memory" }),
        decision: mergeDecision,
        baseDir,
        sessionKey: "session-1",
        sessionId: "session-1",
        vectorStore: store,
      });
      expect(rec3!.timestamps).toEqual([t1, t2, t3]);

      const finalRows = store.queryL1Records({ sessionId: "session-1" });
      expect(finalRows.map((r) => r.record_id)).toEqual(["rec-3"]);
      expect(finalRows[0].timestamp_str).toBe(t1);
      expect(finalRows[0].timestamp_start).toBe(t1);
      expect(finalRows[0].timestamp_end).toBe(t3);
    } finally {
      store.close();
    }
  });
});

describe("createdAt and updatedAt behavior remains unchanged", () => {
  it("sets createdAt and updatedAt to the current write time on both store and merge/update", async () => {
    const baseDir = await makeTempDir();
    const store = new VectorStore(path.join(baseDir, "vectors.db"), 0);
    store.init();

    try {
      vi.useFakeTimers();

      vi.setSystemTime(new Date(t1));
      const stored = await writeMemory({
        memory: newMemory({ record_id: "rec-1" }),
        decision: { record_id: "rec-1", action: "store", target_ids: [] },
        baseDir,
        sessionKey: "session-1",
        sessionId: "session-1",
        vectorStore: store,
      });
      expect(stored!.createdAt).toBe(t1);
      expect(stored!.updatedAt).toBe(t1);

      vi.setSystemTime(new Date(t2));
      const [decision] = applyDedupProvenance(
        [
          {
            record_id: "rec-2",
            action: "merge",
            target_ids: ["rec-1"],
            merged_content: "Merged content",
          },
        ],
        [
          {
            newMemory: newMemory({ record_id: "rec-2" }),
            candidates: [candidate("rec-1", [t1])],
          },
        ],
      );
      const merged = await writeMemory({
        memory: newMemory({ record_id: "rec-2" }),
        decision,
        baseDir,
        sessionKey: "session-1",
        sessionId: "session-1",
        vectorStore: store,
      });

      expect(merged!.timestamps).toEqual([t1, t2]);
      expect(merged!.createdAt).toBe(t2);
      expect(merged!.updatedAt).toBe(t2);

      const [row] = store.queryL1Records({ recordIds: ["rec-2"] });
      expect(row.created_time).toBe(t2);
      expect(row.updated_time).toBe(t2);
    } finally {
      store.close();
    }
  });
});

describe("uniqueSortedTimestamps", () => {
  it("drops invalid/empty strings, normalizes ISO offsets to UTC, de-duplicates, and sorts chronologically", () => {
    expect(
      uniqueSortedTimestamps([
        t2,
        "",
        "not-a-date",
        "record 1",
        "2026-09-08T12:00:00+08:00",
        t1,
        t2,
        undefined,
      ]),
    ).toEqual([t1, t2]);
  });
});

// ============================================================================
// Independent safety hardening: invalid `target_ids` guard
// ============================================================================

describe("independent safety hardening — invalid target_ids guard", () => {
  it("falls back to store with original content when every target is outside the candidate pool", () => {
    const matches: CandidateMatch[] = [
      {
        newMemory: newMemory({ record_id: "new-1" }),
        candidates: [candidate("old-1", [t1])],
      },
    ];
    const decisions: DedupDecision[] = [
      {
        record_id: "new-1",
        action: "merge",
        target_ids: ["not-in-pool"],
        merged_content: "Merged with a hallucinated record.",
        merged_type: "instruction",
        merged_priority: 90,
      },
    ];

    const [out] = applyDedupProvenance(decisions, matches);
    expect(out).toEqual({ record_id: "new-1", action: "store", target_ids: [] });
  });

  it("falls back to store with original content when targets mix valid and invalid IDs", () => {
    const warnings: string[] = [];
    const logger: Logger = {
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
    };
    const matches: CandidateMatch[] = [
      {
        newMemory: newMemory({ record_id: "new-1" }),
        candidates: [candidate("old-1", [t1])],
      },
    ];
    const decisions: DedupDecision[] = [
      {
        record_id: "new-1",
        action: "update",
        target_ids: ["old-1", "not-in-pool"],
        merged_content: "Combined valid and invalid targets.",
      },
    ];

    const [out] = applyDedupProvenance(decisions, matches, logger);
    expect(out).toEqual({ record_id: "new-1", action: "store", target_ids: [] });
    expect(warnings).toEqual([
      "[memory-tdai][l1-dedup] Falling back to store for new-1 (update → store, reason=mixed_targets)",
    ]);
  });

  it("falls back to store when merge/update lists no targets", () => {
    const matches: CandidateMatch[] = [
      {
        newMemory: newMemory({ record_id: "new-1" }),
        candidates: [candidate("old-1", [t1])],
      },
    ];
    const [out] = applyDedupProvenance(
      [
        {
          record_id: "new-1",
          action: "merge",
          target_ids: [],
          merged_content: "Merged with nobody.",
        },
      ],
      matches,
    );
    expect(out).toEqual({ record_id: "new-1", action: "store", target_ids: [] });

    expect(
      normalizeDedupDecisionForWrite({
        record_id: "new-1",
        action: "update",
        target_ids: ["", "  "],
        merged_content: "Do not persist this.",
      }),
    ).toEqual({ record_id: "new-1", action: "store", target_ids: [] });
  });

  it("strips blank target IDs, trims whitespace, and de-duplicates target IDs instead of treating them as mixed", () => {
    const matches: CandidateMatch[] = [
      {
        newMemory: newMemory({ record_id: "new-1" }),
        candidates: [candidate("old-1", [t1])],
      },
    ];
    const [out] = applyDedupProvenance(
      [
        {
          record_id: "new-1",
          action: "update",
          target_ids: [" old-1 ", "old-1", "", "  "],
          merged_content: "Use UTC for reports.",
        },
      ],
      matches,
    );

    expect(out.action).toBe("update");
    expect(out.target_ids).toEqual(["old-1"]);
    expect(out.merged_content).toBe("Use UTC for reports.");

    const normalized = normalizeDedupDecisionForWrite({
      record_id: "new-1",
      action: "update",
      target_ids: [" old-1 ", "old-1", ""],
      merged_content: "Use UTC for reports.",
    });
    expect(normalized.action).toBe("update");
    expect(normalized.target_ids).toEqual(["old-1"]);
  });

  it("falls back to original memory content when merged_content is blank on merge/update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(t2));
    const baseDir = await makeTempDir();

    const matches: CandidateMatch[] = [
      {
        newMemory: newMemory({ record_id: "new-1", content: "Original non-empty memory." }),
        candidates: [candidate("old-1", [t1])],
      },
    ];
    const [decision] = applyDedupProvenance(
      [
        {
          record_id: "new-1",
          action: "update",
          target_ids: ["old-1"],
          merged_content: "   ",
        },
      ],
      matches,
    );

    expect(decision.merged_content).toBeUndefined();

    const record = await writeMemory({
      memory: newMemory({ record_id: "new-1", content: "Original non-empty memory." }),
      decision: {
        ...decision,
        merged_content: "",
      },
      baseDir,
      sessionKey: "session-1",
      sessionId: "session-1",
    });

    expect(record).not.toBeNull();
    expect(record!.content).toBe("Original non-empty memory.");
  });

  it("keeps skip unchanged", () => {
    const matches: CandidateMatch[] = [
      {
        newMemory: newMemory({ record_id: "new-1" }),
        candidates: [candidate("old-1", [t1])],
      },
    ];
    const [out] = applyDedupProvenance(
      [
        {
          record_id: "new-1",
          action: "skip",
          target_ids: ["old-1"],
        },
      ],
      matches,
    );
    expect(out.action).toBe("skip");
    expect(out.target_ids).toEqual(["old-1"]);
  });
});
