/**
 * Regression tests for Issue #1239 Bug 1:
 *
 *   "[WorkBuddy] Session Init 三处缺陷导致无法完成团队资产绑定与 L0 写入"
 *
 * Bug 1: WorkBuddy echoes the whole question — including the SKIP_HINT that
 * literally contains the word "跳过" — back as the tool_result, followed by
 * the user's pick after a ` → ` separator:
 *
 *   · 请选择本次会话所属的 Team：（如选择"跳过"选项，本次 session init 将跳过，
 *     不注入任何团队资产） → global-dev (nnfs4)
 *
 * `extractTeamFromOptionText` tests `SKIP_RE = /跳过|不关联|skip/i` against
 * the FULL text before attempting any team match, so the question's own
 * wording trips the bypass and the session is registered with
 * `sessionInfo=null` — no injection, no L0 write, and `bypassed=true` in the
 * logs even though the user picked a team.
 *
 * The sibling extractors already learned this lesson:
 *   - `extractOpencodeAnswers` strips opencode's
 *     `User has answered your questions: "..."="answer"` wrapper;
 *   - `extractAgentOnly` / `extractTaskOnly` match FIRST and only fall back
 *     to SKIP_RE when nothing matched (with regression comments).
 * `extractTeamFromOptionText` is the one entry point still doing
 * SKIP-before-match, and it has no workbuddy ` → ` unwrapping at all.
 *
 * The ClaudeCode twin is unaffected because its `teamText` comes from
 * `extractAnswerFromJson(content)`, which already yields the bare answer.
 */

import { describe, expect, it } from "vitest";
import { BYPASS_MARKER, extractTeamFromOptionText } from "../extractor.js";
import type { TeamOption } from "../../types.js";

const TEAMS: TeamOption[] = [
  {
    team_id: "11112222-3333-4444-5555-666677778888",
    team_name: "global-dev",
    agents: [{ agent_id: "aaaabbbb", agent_name: "builder", description: "" }],
    tasks: [{ task_id: "task-daily", task_name: "日常开发" }],
  },
  {
    team_id: "99990000-1111-2222-3333-444455556666",
    team_name: "global-prod",
    agents: [{ agent_id: "ccccdddd", agent_name: "reviewer", description: "" }],
    tasks: [{ task_id: "task-rel", task_name: "发布" }],
  },
];

/** The exact shape WorkBuddy writes back: question (with SKIP_HINT) → answer. */
function wbTeamToolResult(teamLabel: string): string {
  return (
    "· 请选择本次会话所属的 Team：" +
    '（如选择"跳过"选项，本次 session init 将跳过，不注入任何团队资产）' +
    ` → ${teamLabel}`
  );
}

describe("Issue #1239 Bug 1 — question text must not trip the skip bypass", () => {
  it("resolves the team when the echoed question contains 跳过 (workbuddy arrow form)", () => {
    const result = extractTeamFromOptionText(
      wbTeamToolResult("global-dev (77778888)"),
      TEAMS,
    );

    expect(result).toBe("11112222-3333-4444-5555-666677778888");
    expect(result).not.toBe(BYPASS_MARKER);
  });

  it("still bypasses when the user actually picks the skip option", () => {
    // The user's own answer is the skip label — that MUST stay a bypass.
    const result = extractTeamFromOptionText(
      wbTeamToolResult("本次不关联（跳过注入，直接放行）"),
      TEAMS,
    );

    expect(result).toBe(BYPASS_MARKER);
  });

  it("still bypasses when the user types 跳过 as a free-form answer", () => {
    const result = extractTeamFromOptionText("跳过", TEAMS);
    expect(result).toBe(BYPASS_MARKER);
  });

  it("keeps working for the bare-answer path (no question wrapper)", () => {
    const result = extractTeamFromOptionText("global-prod (66666666)", TEAMS);
    expect(result).toBe("99990000-1111-2222-3333-444455556666");
  });

  it("keeps the opencode wrapper unwrapping intact", () => {
    const content =
      'User has answered your questions: "请选择 Team（跳过则不关联）"="global-dev (77778888)"';
    const result = extractTeamFromOptionText(content, TEAMS);
    expect(result).toBe("11112222-3333-4444-5555-666677778888");
  });

  it("does not treat a team name containing no skip wording as bypass", () => {
    const result = extractTeamFromOptionText("global-dev", TEAMS);
    expect(result).toBe("11112222-3333-4444-5555-666677778888");
  });
});
