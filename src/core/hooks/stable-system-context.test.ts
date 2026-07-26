import { describe, expect, it } from "vitest";

import { buildStableSystemContext } from "./stable-system-context.js";
import { digestStableSystemPrompt } from "../../utils/system-prompt-dedupe.js";

const PERSONA = "用户偏好简洁回答，使用中文，关注数据库与缓存主题。";
const SCENE_NAV = "- scene/2026-07/release-brief.md — Aurora Ledger 发布准备";

/** Simulate the dynamic half of a turn: different L1 recall every time. */
function dynamicRecallForTurn(turn: number): string {
  return `<relevant-memories>\n- [episodic] turn ${turn} memory ${"x".repeat(turn * 7)}\n</relevant-memories>`;
}

describe("stable system context assembly", () => {
  it("includes persona, scene navigation and the tools guide in a fixed order", () => {
    const result = buildStableSystemContext({
      persona: PERSONA,
      sceneNavigation: SCENE_NAV,
      hasDynamicRecall: true,
    });

    expect(result.sources).toEqual(["persona", "scene-navigation", "memory-tools-guide"]);
    expect(result.text).toContain("<user-persona>");
    expect(result.text).toContain("<scene-navigation>");
    expect(result.text).toContain("<memory-tools-guide>");
  });

  it("never carries dynamic recall markup", () => {
    const result = buildStableSystemContext({
      persona: PERSONA,
      sceneNavigation: SCENE_NAV,
      hasDynamicRecall: true,
    });

    expect(result.text).not.toContain("<relevant-memories>");
    expect(result.text).not.toContain("<memory-reminders>");
  });

  it("produces nothing when there is neither stable content nor dynamic recall", () => {
    const result = buildStableSystemContext({ hasDynamicRecall: false });

    expect(result.text).toBeUndefined();
    expect(result.sources).toEqual([]);
  });

  it("emits only the tools guide when dynamic recall exists without a profile", () => {
    const result = buildStableSystemContext({ hasDynamicRecall: true });

    expect(result.sources).toEqual(["memory-tools-guide"]);
  });
});

describe("stable system context is byte-stable across turns", () => {
  // This is the property that makes the block worth placing before the host
  // cache boundary. If it churned, moving it into the reusable prefix would
  // make caching worse rather than better: every turn would invalidate the
  // prefix for the whole request instead of just its own tail.
  it("keeps the same bytes while dynamic recall changes every turn", () => {
    const digests = new Set<string>();

    for (let turn = 1; turn <= 10; turn++) {
      // The dynamic half changes on every turn and must not leak in.
      const dynamic = dynamicRecallForTurn(turn);
      expect(dynamic).toContain(`turn ${turn}`);

      const stable = buildStableSystemContext({
        persona: PERSONA,
        sceneNavigation: SCENE_NAV,
        hasDynamicRecall: true,
      });
      digests.add(digestStableSystemPrompt(stable.text ?? ""));
    }

    expect(digests.size).toBe(1);
  });

  it("is unaffected by whether a turn carries dynamic recall", () => {
    // Turns where recall finds nothing must not shrink the cached prefix,
    // otherwise an empty-recall turn would invalidate it for every later turn.
    const withRecall = buildStableSystemContext({
      persona: PERSONA,
      sceneNavigation: SCENE_NAV,
      hasDynamicRecall: true,
    });
    const withoutRecall = buildStableSystemContext({
      persona: PERSONA,
      sceneNavigation: SCENE_NAV,
      hasDynamicRecall: false,
    });

    expect(withoutRecall.text).toBe(withRecall.text);
  });

  it("changes exactly once when the persona is edited mid-session", () => {
    const digestsByTurn: string[] = [];

    for (let turn = 1; turn <= 9; turn++) {
      const persona = turn < 5 ? PERSONA : `${PERSONA} 新增：偏好表格输出。`;
      const stable = buildStableSystemContext({
        persona,
        sceneNavigation: SCENE_NAV,
        hasDynamicRecall: true,
      });
      digestsByTurn.push(digestStableSystemPrompt(stable.text ?? ""));
    }

    const transitions = digestsByTurn.filter((digest, i) => i > 0 && digest !== digestsByTurn[i - 1]);
    expect(transitions).toHaveLength(1);
    // The break lands on the edit, not before or after it.
    expect(digestsByTurn[3]).not.toBe(digestsByTurn[4]);
    expect(digestsByTurn[4]).toBe(digestsByTurn[8]);
  });

  it("ignores line-ending and trailing-whitespace churn in profile files", () => {
    // persona.md is rewritten by the L3 pipeline; a CRLF or trailing-newline
    // difference must not invalidate the cached prefix.
    const lf = buildStableSystemContext({
      persona: "第一行\n第二行",
      sceneNavigation: SCENE_NAV,
      hasDynamicRecall: true,
    });
    const crlf = buildStableSystemContext({
      persona: "第一行\r\n第二行\r\n  ",
      sceneNavigation: SCENE_NAV,
      hasDynamicRecall: true,
    });

    expect(digestStableSystemPrompt(crlf.text ?? "")).toBe(digestStableSystemPrompt(lf.text ?? ""));
  });

  it("emits the tools guide exactly once", () => {
    // The guide is appended from two conditions (a stable part exists, or
    // dynamic recall exists). Emitting it twice would add ~600 stable chars
    // to every request in the reusable prefix.
    const text = buildStableSystemContext({
      persona: PERSONA,
      sceneNavigation: SCENE_NAV,
      hasDynamicRecall: true,
    }).text ?? "";

    expect(text.split("<memory-tools-guide>")).toHaveLength(2);
  });
});
