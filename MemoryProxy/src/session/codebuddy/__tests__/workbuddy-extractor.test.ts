import { describe, expect, it } from "vitest";
import type { TeamOption } from "../../types.js";
import {
  BYPASS_MARKER,
  extractAgentOnly,
  extractAssetConfirm,
  extractTaskOnly,
  extractTeamFromOptionText,
} from "../extractor.js";

const team: TeamOption = {
  team_id: "team-12345678",
  team_name: "home",
  agents: [
    { agent_id: "agent-workbuddy-0001", agent_name: "workbuddy" },
    { agent_id: "agent-coder-0000002", agent_name: "coder" },
  ],
  tasks: [{ task_id: "task-12345678", task_name: "general" }],
};

const skipHint =
  '（如选择"跳过"选项，本次 session init 将跳过，不注入任何团队资产）';

describe("WorkBuddy AskUserQuestion answer extraction", () => {
  it("keeps the selected asset-confirm answer instead of the skip hint", () => {
    const content = ` · 本次对话是否要关联团队资产？${skipHint} → 是，关联团队资产`;
    expect(extractAssetConfirm(content)).toBe(true);
  });

  it("extracts a Team selection from the rendered question and answer line", () => {
    const content =
      ` · 请选择本次会话所属的 Team：${skipHint} → ` +
      `${team.team_name} (${team.team_id.slice(-8)})`;
    expect(extractTeamFromOptionText(content, [team])).toBe(team.team_id);
  });

  it("reproduces and fixes the production Agent selection", () => {
    const content =
      ` · 请选择「home」下要使用的 Agent：${skipHint} → workbuddy (ddy-0001)`;
    expect(extractAgentOnly(content, [team], team.team_id)).toBe("agent-workbuddy-0001");
  });

  it("extracts a Task selection without treating the question hint as bypass", () => {
    const content =
      ` · 请选择「home」下要关联的任务：${skipHint} → general (12345678)`;
    expect(extractTaskOnly(content, [team], team.team_id)).toBe("task-12345678");
  });

  it("preserves an explicit skip answer", () => {
    const content =
      ` · 请选择「home」下要使用的 Agent：${skipHint} → 跳过`;
    expect(extractAgentOnly(content, [team], team.team_id)).toBe(BYPASS_MARKER);
  });

  it("does not turn the pagination label into an Agent selection", () => {
    const content =
      ` · 请选择「home」下要使用的 Agent：${skipHint} → 更多 →`;
    expect(extractAgentOnly(content, [team], team.team_id)).toBeNull();
  });
});
