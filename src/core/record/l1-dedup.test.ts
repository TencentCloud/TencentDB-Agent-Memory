import { describe, expect, it } from "vitest";

import { parseBatchResult } from "./l1-dedup.js";
import type { ExtractedMemory } from "./l1-writer.js";

function memory(record_id: string): ExtractedMemory & { record_id: string } {
  return {
    record_id,
    content: "用户在诊断场景要求 AI 只回复 OK",
    type: "instruction",
    priority: 75,
    source_message_ids: ["m1"],
    metadata: {},
    scene_name: "诊断调试",
  };
}

describe("parseBatchResult", () => {
  it("ignores bracketed prose before and after the conflict decision JSON array", () => {
    const raw = `可选动作包括 [store/update/merge/skip]，下面才是决策：
[
  {
    "record_id": "new-1",
    "action": "merge",
    "target_ids": ["old-1"],
    "merged_content": "用户只在诊断调试场景要求 AI 只回复 OK",
    "merged_type": "instruction",
    "merged_priority": 75,
    "merged_timestamps": ["2026-06-25T00:00:00.000Z"]
  }
]
解析完成：[ok]`;

    expect(parseBatchResult(raw, [memory("new-1")])).toEqual([
      {
        record_id: "new-1",
        action: "merge",
        target_ids: ["old-1"],
        merged_content: "用户只在诊断调试场景要求 AI 只回复 OK",
        merged_type: "instruction",
        merged_priority: 75,
        merged_timestamps: ["2026-06-25T00:00:00.000Z"],
      },
    ]);
  });

  it("accepts object-wrapped decision arrays even when earlier fields contain arrays", () => {
    const raw = JSON.stringify({
      notes: ["store/update/merge/skip are valid actions"],
      decisions: [
        {
          record_id: "new-2",
          action: "skip",
          target_ids: ["old-2"],
        },
      ],
    });

    expect(parseBatchResult(raw, [memory("new-2")])).toEqual([
      {
        record_id: "new-2",
        action: "skip",
        target_ids: ["old-2"],
      },
    ]);
  });
});
