import { describe, expect, it } from "vitest";
import { buildSessionSnapshot } from "./session-snapshot.js";

describe("buildSessionSnapshot", () => {
  it("is deterministic and excludes dynamic or volatile fields", () => {
    const input = {
      persona: "  用户偏好中文回答。\n",
      sceneNavigation: "- 项目A\n- 项目B",
      stableMemories: [
        { id: "m2", content: "第二条", type: "instruction" },
        { id: "m1", content: "第一条", type: "persona", score: 0.98, createdAt: "2026-01-01T00:00:00Z" },
      ],
      maxTokens: 200,
    };

    const first = buildSessionSnapshot(input);
    const second = buildSessionSnapshot({ ...input, now: "2026-07-06T00:00:00Z" });

    expect(second).toEqual(first);
    expect(first.text).toContain("<session-context");
    expect(first.text).toContain("hash=");
    expect(first.text).toContain("m1");
    expect(first.text.indexOf("m1")).toBeLessThan(first.text.indexOf("m2"));
    expect(first.text).not.toContain("score");
    expect(first.text).not.toContain("createdAt");
    expect(first.text).not.toContain("2026-07-06");
  });
});
