import { describe, expect, it } from "vitest";
import { appendTaskDeltaMessage, buildTaskDeltaMessage, buildTaskSnapshot } from "./task-snapshot.js";

describe("task snapshot and delta", () => {
  it("keeps full Mermaid out of delta messages and appends without mutating old messages", () => {
    const fullMermaid = "flowchart TD\nA[done] --> B[doing]\nB --> C[todo]";
    const snapshot = buildTaskSnapshot({
      taskGoal: "完成 D 方案",
      mmdFile: "task.mmd",
      mermaid: fullMermaid,
      resultRef: "refs/task-full.md",
    });
    const delta = buildTaskDeltaMessage({
      taskGoal: "完成 D 方案",
      mmdFile: "task.mmd",
      changedNodeIds: ["B", "C"],
      resultRef: "refs/task-full.md",
      maxChars: 200,
    });
    const before = [{ role: "user", content: "hello" }];
    const copy = JSON.stringify(before);
    const after = appendTaskDeltaMessage(before, delta);

    expect(snapshot.text).toContain("refs/task-full.md");
    expect(snapshot.text).toContain("hash=");
    expect(delta.content[0].text).not.toContain("flowchart TD");
    expect(delta.content[0].text).toContain("changed_nodes");
    expect(JSON.stringify(before)).toBe(copy);
    expect(after).toHaveLength(2);
  });
});
