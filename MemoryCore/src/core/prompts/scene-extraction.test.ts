/**
 * Contract tests for the scene-extraction prompt (issue #1543).
 *
 * The L2 scene blocks must not grow monotonically: the prompt has to pin the
 * update path to whole-file rewrites, enforce the 1500-char cap as a hard
 * constraint with a pre-write self-check, require single-location storage,
 * and force trajectory entries to merge instead of append. These tests lock
 * those invariants so the wording cannot regress back to permissive phrasing.
 */

import { describe, expect, it } from "vitest";
import { buildSceneExtractionPrompt } from "./scene-extraction.js";

const BASE_PARAMS = {
  memoriesJson: '[{"id": "m1", "content": "user prefers Rust"}]',
  sceneSummaries: "- `work.md`: backend work",
  currentTimestamp: "2026-09-28T00:00:00Z",
  maxScenes: 15,
};

describe("buildSceneExtractionPrompt (#1543 invariants)", () => {
  it("is available for both prompt families (chat and code/work)", () => {
    const chat = buildSceneExtractionPrompt({ ...BASE_PARAMS });
    const work = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode: "code" });
    expect(chat.systemPrompt).toContain("Memory Consolidation Architect");
    expect(work.systemPrompt).toContain("Team Work Method Memory Consolidation Architect");
  });

  it("mandates whole-file rewrite for UPDATE and forbids edit-based content updates", () => {
    for (const promptMode of ["chat", "code"] as const) {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      expect(systemPrompt).toContain("必须整体重写");
      expect(systemPrompt).toContain("禁止用 edit 做内容更新");
      // The permissive wording that made targeted edits the path of least
      // resistance must not come back.
      expect(systemPrompt).not.toContain("或 **edit**");
      expect(systemPrompt).not.toContain("或 edit(");
    }
  });

  it("states the 1500-char cap as a hard constraint with a pre-write self-check", () => {
    for (const promptMode of ["chat", "code"] as const) {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      expect(systemPrompt).toContain("1500 字符");
      expect(systemPrompt).toContain("硬性长度上限");
      expect(systemPrompt).toContain("write 前必须自查");
    }
  });

  it("requires single-location storage for facts", () => {
    for (const promptMode of ["chat", "code"] as const) {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      expect(systemPrompt).toContain("单点存储");
    }
  });

  it("forces trajectory entries to merge instead of append", () => {
    const chat = buildSceneExtractionPrompt({ ...BASE_PARAMS });
    expect(chat.systemPrompt).toContain("禁止把过程性事件当作演变记录");
    expect(chat.systemPrompt).toContain("禁止追加重复条目");
    const work = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode: "code" });
    expect(work.systemPrompt).toContain("禁止把过程性事件当作演化记录");
    expect(work.systemPrompt).toContain("禁止追加重复条目");
  });

  it("keeps the dynamic inputs wired into the user prompt", () => {
    const { userPrompt } = buildSceneExtractionPrompt(BASE_PARAMS);
    expect(userPrompt).toContain(BASE_PARAMS.memoriesJson);
    expect(userPrompt).toContain(BASE_PARAMS.sceneSummaries);
    expect(userPrompt).toContain(BASE_PARAMS.currentTimestamp);
    expect(userPrompt).toContain("`work.md`");
  });

  it("still interpolates maxScenes", () => {
    const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, maxScenes: 7 });
    expect(systemPrompt).toContain("7");
    expect(systemPrompt).not.toContain("${maxScenes}");
  });
});
