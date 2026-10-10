import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../core/storage/adapter.js";
import { extractMmdMeta, handleTaskTransition } from "./task-transition.js";
import type { OffloadState, TaskJudgment } from "./types.js";

const basePath = "offload/instance-a/session-a";
const newLongTask: TaskJudgment = {
  taskCompleted: true, isLongTask: true, isContinuation: false, newTaskLabel: "Refactor API",
};

function fixture(activeMmdFile: string | null = "003-previous.mmd") {
  const state: OffloadState = { activeMmdFile, boundaries: [], lastL15CreatedAt: 42 };
  const readdirNames = vi.fn<StorageAdapter["readdirNames"]>().mockResolvedValue([]);
  const writeFile = vi.fn<StorageAdapter["writeFile"]>().mockResolvedValue(undefined);
  // This use case only needs the listing/writing port; other storage operations must not occur.
  const storage = { readdirNames, writeFile } as unknown as StorageAdapter;
  return { state, storage, readdirNames, writeFile };
}

describe("handleTaskTransition", () => {
  it("creates a sanitized new task after the greatest existing sequence in the session", async () => {
    const f = fixture();
    f.readdirNames.mockResolvedValue(["002-old.mmd", "011-latest.mmd", "notes.mmd", "006-middle.mmd"]);
    await handleTaskTransition(f.state, newLongTask, f.storage, basePath);
    expect(f.readdirNames).toHaveBeenCalledWith(`${basePath}/mmds/`, ".mmd");
    expect(f.writeFile).toHaveBeenCalledWith(`${basePath}/mmds/012-refactor-api.mmd`, "");
    expect(f.state).toEqual({ activeMmdFile: "012-refactor-api.mmd", boundaries: [], lastL15CreatedAt: 42 });
  });

  it.each([
    ["../../外部任务", "task"],
    ["A".repeat(50), "a".repeat(30)],
  ])("keeps label %s within the MMD directory", async (newTaskLabel, expectedLabel) => {
    const f = fixture();
    await handleTaskTransition(f.state, { ...newLongTask, newTaskLabel }, f.storage, basePath);
    expect(f.writeFile).toHaveBeenCalledWith(`${basePath}/mmds/001-${expectedLabel}.mmd`, "");
  });

  it("switches to a historical task without creating or overwriting its content", async () => {
    const f = fixture();
    await handleTaskTransition(f.state, {
      taskCompleted: true, isLongTask: true, isContinuation: true, continuationMmdFile: "001-history.mmd",
    }, f.storage, basePath);
    expect(f.state.activeMmdFile).toBe("001-history.mmd");
    expect(f.readdirNames).not.toHaveBeenCalled();
    expect(f.writeFile).not.toHaveBeenCalled();
  });

  it("clears active context after a completed short task", async () => {
    const f = fixture();
    await handleTaskTransition(f.state, { taskCompleted: true, isLongTask: false, isContinuation: false }, f.storage, basePath);
    expect(f.state.activeMmdFile).toBeNull();
    expect(f.writeFile).not.toHaveBeenCalled();
  });

  it("keeps an existing in-progress task even when a new label is proposed", async () => {
    const f = fixture();
    await handleTaskTransition(f.state, { ...newLongTask, taskCompleted: false }, f.storage, basePath);
    expect(f.state.activeMmdFile).toBe("003-previous.mmd");
    expect(f.writeFile).not.toHaveBeenCalled();
  });

  it("creates fallback context for an in-progress long task without an active file", async () => {
    const f = fixture(null);
    await handleTaskTransition(f.state, { taskCompleted: false, isLongTask: true, isContinuation: false }, f.storage, basePath);
    expect(f.state.activeMmdFile).toBe("001-current-task.mmd");
  });

  it.each(["list", "write"])("preserves the old task when storage %s fails", async (failure) => {
    const f = fixture();
    const error = new Error("storage unavailable");
    if (failure === "list") f.readdirNames.mockRejectedValue(error);
    else f.writeFile.mockRejectedValue(error);
    await expect(handleTaskTransition(f.state, newLongTask, f.storage, basePath)).rejects.toThrow(error);
    expect(f.state.activeMmdFile).toBe("003-previous.mmd");
    if (failure === "list") expect(f.writeFile).not.toHaveBeenCalled();
  });
});

describe("extractMmdMeta", () => {
  it("counts actionable statuses and keeps paused/blocked nodes available for continuation", () => {
    const content = [
      '%%{"taskGoal":"Ship API","updatedTime":"2026-10-09"}%%',
      "flowchart TD",
      'a["status: done<br/>summary: schema ready"]',
      'b["status: DOING<br/>summary: implementing API<br/>owner: user"]',
      'c["status: todo<br/>summary: tests"]',
      'd["status: paused<br/>summary: waiting"]',
      'e["status: blocked<br/>summary: dependency"]',
    ].join("\n");
    const meta = extractMmdMeta("001-api.mmd", content);
    expect(meta).toMatchObject({ filename: "001-api.mmd", taskGoal: "Ship API", updatedTime: "2026-10-09", doneCount: 1, doingCount: 1, todoCount: 1 });
    expect(meta.nodeSummaries).toEqual([
      { nodeId: "a", status: "done", summary: "schema ready" },
      { nodeId: "b", status: "doing", summary: "implementing API" },
      { nodeId: "c", status: "todo", summary: "tests" },
      { nodeId: "d", status: "paused", summary: "waiting" },
      { nodeId: "e", status: "blocked", summary: "dependency" },
    ]);
  });

  it("recovers status counts when metadata JSON or node syntax is malformed", () => {
    expect(extractMmdMeta("legacy.mmd", '%%{invalid json}%%\nstatus: done\nstatus: todo')).toMatchObject({
      taskGoal: "", updatedTime: null, doneCount: 1, todoCount: 1, doingCount: 0, nodeSummaries: [],
    });
    expect(extractMmdMeta("empty.mmd", "")).toMatchObject({ filename: "empty.mmd", doneCount: 0, doingCount: 0, todoCount: 0 });
  });
});
