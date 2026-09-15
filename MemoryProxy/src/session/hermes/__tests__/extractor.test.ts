/**
 * Hermes clarify 结果解包（hermes/extractor.ts）单测。
 *
 * 覆盖：
 *   - 单题 / 批量 / multi_select 解包
 *   - headless error / 超时 / oneshot / 批量中途弃答 → HERMES_BYPASS_TEXT
 *   - 非 JSON / 无关 JSON → null（走原始 content 老路径）
 *   - 空 user_response → ""（当未识别，状态机计 retry）
 *   - 与 CB extractor 的集成：asset_confirm 双标签回显不误判、MORE 回显不误 bypass
 */
import { describe, expect, it } from "vitest";
import {
  HERMES_BYPASS_TEXT,
  extractHermesAnswers,
} from "../extractor.js";
import { ASSET_CONFIRM_NO, ASSET_CONFIRM_YES, MORE_LABEL } from "../form.js";
import {
  BYPASS_MARKER,
  extractAgentOnly,
  extractAssetConfirm,
  extractTaskOnly,
  extractTeamFromOptionText,
} from "../../codebuddy/extractor.js";
import type { TeamOption } from "../../types.js";

const TEAM: TeamOption = {
  team_id: "team-d03qdb2oty",
  team_name: "测试团队",
  agents: [
    { agent_id: "agt-11111111", agent_name: "agent-one" },
    { agent_id: "agt-22222222", agent_name: "agent-two" },
  ],
  tasks: [
    { task_id: "task-33333333", task_name: "任务一" },
    { task_id: "task-44444444", task_name: "任务二" },
  ],
};

describe("extractHermesAnswers — 单题", () => {
  it("unwraps user_response", () => {
    const raw = JSON.stringify({
      question: "请选择本次会话所属的 Team：",
      choices_offered: ["测试团队 (d03qdb2oty)", MORE_LABEL],
      user_response: "测试团队 (d03qdb2oty)",
    });
    expect(extractHermesAnswers(raw)).toBe("测试团队 (d03qdb2oty)");
  });

  it("multi_select array joins with |", () => {
    const raw = JSON.stringify({
      question: "选一个",
      choices_offered: ["A", "B", "C"],
      user_response: ["A", "C"],
    });
    expect(extractHermesAnswers(raw)).toBe("A | C");
  });

  it("empty user_response → empty string (unrecognized, not null)", () => {
    const raw = JSON.stringify({ question: "Q", choices_offered: [], user_response: "" });
    expect(extractHermesAnswers(raw)).toBe("");
  });

  it("timeout sentinel → bypass text", () => {
    const raw = JSON.stringify({
      question: "Q",
      choices_offered: ["A"],
      user_response:
        "The user did not provide a response within the time limit. Use your best judgement to make the choice and proceed.",
    });
    expect(extractHermesAnswers(raw)).toBe(HERMES_BYPASS_TEXT);
  });

  it("oneshot auto-answer → bypass text", () => {
    const raw = JSON.stringify({
      question: "Q",
      choices_offered: ["A"],
      user_response: "[oneshot mode: no user available. Pick the best option from <choices> using your own judgment and continue.]",
    });
    expect(extractHermesAnswers(raw)).toBe(HERMES_BYPASS_TEXT);
  });
});

describe("extractHermesAnswers — 批量", () => {
  it("unwraps all responses in order", () => {
    const raw = JSON.stringify({
      responses: [
        { question: "Q1", user_response: "agent-one (11111111)" },
        { question: "Q2", user_response: "任务一 (33333333)" },
      ],
    });
    expect(extractHermesAnswers(raw)).toBe("agent-one (11111111) | 任务一 (33333333)");
  });

  it("timed_out=true (user walked away mid-batch) → bypass text", () => {
    const raw = JSON.stringify({
      responses: [{ question: "Q1", user_response: "agent-one (11111111)" }],
      timed_out: true,
    });
    expect(extractHermesAnswers(raw)).toBe(HERMES_BYPASS_TEXT);
  });
});

describe("extractHermesAnswers — bypass / 非 hermes 信封", () => {
  it("headless error envelope → bypass text", () => {
    const raw = JSON.stringify({ error: "Clarify tool is not available in this execution context." });
    expect(extractHermesAnswers(raw)).toBe(HERMES_BYPASS_TEXT);
  });

  it("bypass text satisfies both asset-NO and SKIP_RE semantics", () => {
    expect(HERMES_BYPASS_TEXT.includes(ASSET_CONFIRM_NO)).toBe(true);
    expect(/跳过|不关联|skip/i.test(HERMES_BYPASS_TEXT)).toBe(true);
    // 刻意不含虚拟 default 任务 label "本次不关联任务"
    expect(HERMES_BYPASS_TEXT.includes("本次不关联任务")).toBe(false);
  });

  it("non-JSON content → null", () => {
    expect(extractHermesAnswers("测试团队 (d03qdb2oty)")).toBeNull();
    expect(extractHermesAnswers("<question_answer>...</question_answer>")).toBeNull();
    expect(extractHermesAnswers("")).toBeNull();
  });

  it("unrelated JSON → null", () => {
    expect(extractHermesAnswers('{"status":"success","result":1}')).toBeNull();
    expect(extractHermesAnswers("not json {")).toBeNull();
  });
});

describe("hermes 解包 × CB extractor 集成", () => {
  it("asset_confirm: 结果回显双标签时按 user_response 判定，不误判 YES", () => {
    const raw = JSON.stringify({
      question: "本次对话是否要关联团队资产？（如选择\"跳过\"选项，本次 session init 将跳过，不注入任何团队资产）",
      choices_offered: [ASSET_CONFIRM_YES, ASSET_CONFIRM_NO],
      user_response: ASSET_CONFIRM_NO,
    });
    // 不解包的话 includes(ASSET_CONFIRM_YES) 恒命中 → true（错误）。
    expect(extractAssetConfirm(raw)).toBe(false);
  });

  it("team: 回显 choices_offered 不蹭到其它团队名 / 不误 bypass", () => {
    const other = { ...TEAM, team_name: "跳过跳过团队" };
    const raw = JSON.stringify({
      question: "请选择 Team：",
      choices_offered: ["测试团队 (d03qdb2oty)", "跳过跳过团队 (00000000)"],
      user_response: "测试团队 (d03qdb2oty)",
    });
    // 回显里有"跳过"字样（other 团队名），不解包会 SKIP_RE 误 bypass。
    expect(extractTeamFromOptionText(raw, [TEAM, other])).toBe(TEAM.team_id);
  });

  it("agent: MORE 回显不解包会误 bypass；解包后走未识别 → null", () => {
    const raw = JSON.stringify({
      question: "请选择 Agent（第 1/3 页）：",
      choices_offered: ["agent-one (11111111)", "agent-two (22222222)", MORE_LABEL],
      user_response: MORE_LABEL,
    });
    expect(extractAgentOnly(raw, [TEAM], TEAM.team_id)).not.toBe(BYPASS_MARKER);
    expect(extractAgentOnly(raw, [TEAM], TEAM.team_id)).toBeNull();
  });

  it("task: choices_offered 含 MORE 时只匹配实际 user_response", () => {
    const raw = JSON.stringify({
      question: "请选择 Task（第 1/2 页）：",
      choices_offered: ["任务一 (33333333)", "任务二 (44444444)", MORE_LABEL],
      user_response: "任务二 (44444444)",
    });
    expect(extractHermesAnswers(raw)).toBe("任务二 (44444444)");
    expect(extractTaskOnly(raw, [TEAM], TEAM.team_id)).toBe("task-44444444");
  });

  it("bypass 信封在 agent/task/team 提取器里命中 BYPASS_MARKER", () => {
    expect(extractAgentOnly(HERMES_BYPASS_TEXT, [TEAM], TEAM.team_id)).toBe(BYPASS_MARKER);
    expect(extractTaskOnly(HERMES_BYPASS_TEXT, [TEAM], TEAM.team_id)).toBe(BYPASS_MARKER);
    expect(extractTeamFromOptionText(HERMES_BYPASS_TEXT, [TEAM])).toBe(BYPASS_MARKER);
  });

  it("task: bypass 信封不命中虚拟 default 任务条目", () => {
    const teamWithDefault: TeamOption = {
      ...TEAM,
      tasks: [{ task_id: "task-default", task_name: "本次不关联任务", isDefault: true }, ...TEAM.tasks],
    };
    expect(extractTaskOnly(HERMES_BYPASS_TEXT, [teamWithDefault], TEAM.team_id)).toBe(BYPASS_MARKER);
  });
});
