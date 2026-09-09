import { describe, it, expect } from "vitest";
import { buildFormResponse, buildClarifyArgs, FormData, TOOL_NAME, TOOLCALL_PREFIX, containsFormTitle, isSessionInitToolCallId } from "../form.js";
import type { TeamOption } from "../../types.js";

const mockTeams: TeamOption[] = [
  {
    team_id: "team-aaa-11112222",
    team_name: "Alpha",
    agents: [
      { agent_id: "agent-aaa-33334444", agent_name: "AgentA" },
      { agent_id: "agent-bbb-55556666", agent_name: "AgentB" },
    ],
    tasks: [
      { task_id: "task-default", task_name: "本次不关联任务", isDefault: true },
      { task_id: "task-aaa-77778888", task_name: "TaskX" },
    ],
  },
  {
    team_id: "team-bbb-99990000",
    team_name: "Beta",
    agents: [
      { agent_id: "agent-ccc-11112222", agent_name: "AgentC" },
    ],
    tasks: [
      { task_id: "task-default", task_name: "本次不关联任务", isDefault: true },
    ],
  },
];

describe("hermes form", () => {
  it("buildClarifyArgs team stage produces choices with team names", () => {
    const data: FormData = { teams: mockTeams, stage: "team" };
    const result = buildClarifyArgs(data);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].multi_select).toBe(false);
    expect(result.questions[0].choices.length).toBeGreaterThanOrEqual(1);
    expect(result.questions[0].choices[0]).toContain("Alpha");
  });

  it("buildClarifyArgs asset_confirm stage has 2 choices", () => {
    const data: FormData = { teams: mockTeams, stage: "asset_confirm" };
    const result = buildClarifyArgs(data);
    expect(result.questions[0].choices).toHaveLength(2);
  });

  it("buildFormResponse non-stream returns valid JSON response", async () => {
    const data: FormData = { teams: mockTeams, stage: "team", stream: false, modelId: "test-model" };
    const resp = buildFormResponse(data);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.tool_calls[0].function.name).toBe(TOOL_NAME);
    expect(body.choices[0].finish_reason).toBe("tool_calls");
  });

  it("buildFormResponse stream returns text/event-stream", () => {
    const data: FormData = { teams: mockTeams, stage: "team", stream: true, modelId: "test-model" };
    const resp = buildFormResponse(data);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("containsFormTitle detects known titles", () => {
    expect(containsFormTitle("会话初始化 — 选择 Team")).toBe(true);
    expect(containsFormTitle("random text")).toBe(false);
  });

  it("isSessionInitToolCallId matches prefix", () => {
    expect(isSessionInitToolCallId(TOOLCALL_PREFIX + "123")).toBe(true);
    expect(isSessionInitToolCallId("call_other_123")).toBe(false);
  });

  it("truncates to MAX_CHOICES when too many teams", () => {
    const manyTeams: TeamOption[] = Array.from({ length: 10 }, (_, i) => ({
      team_id: `team-${i}`,
      team_name: `Team${i}`,
      agents: [],
      tasks: [],
    }));
    const data: FormData = { teams: manyTeams, stage: "team" };
    const result = buildClarifyArgs(data);
    expect(result.questions[0].choices.length).toBe(4);
  });
});
