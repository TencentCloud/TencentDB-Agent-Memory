import { describe, expect, it } from "vitest";
import {
  ASSET_CONFIRM_NO,
  ASSET_CONFIRM_YES,
  HERMES_MAX_CHOICES,
  MORE_LABEL,
  TOOL_NAME,
  buildClarifyArgs,
  buildFormResponse,
  type FormData,
  type FormStage,
} from "../form.js";
import type { TeamOption } from "../../types.js";

/** 造一个可控的 team 列表：teams=团队数，agents=每队 agent 数，tasks=每队 task 数。 */
function makeTeams(teams: number, agents: number, tasks: number): TeamOption[] {
  return Array.from({ length: teams }, (_, ti) => ({
    team_id: `team-${String(ti + 1).padStart(8, "0")}`,
    team_name: `Team${ti + 1}`,
    agents: Array.from({ length: agents }, (_, ai) => ({
      agent_id: `agt-${String(ai + 1).padStart(8, "0")}`,
      agent_name: `Agent${ai + 1}`,
      description: "",
    })),
    tasks: Array.from({ length: tasks }, (_, k) => ({
      task_id: `task-${String(k + 1).padStart(8, "0")}`,
      task_name: `Task${k + 1}`,
      isDefault: k === 0,
    })),
  })) as unknown as TeamOption[];
}

function fd(stage: FormStage, extra: Partial<FormData> = {}): FormData {
  return { teams: makeTeams(3, 3, 3), stage, ...extra };
}

describe("hermes clarify arguments（与 hermes 0.19.0 CLARIFY_SCHEMA 对齐）", () => {
  it("是扁平 {question, choices}，不是 {questions:[...]}", () => {
    const args = buildClarifyArgs(fd("asset_confirm"));
    expect(Object.keys(args).sort()).toEqual(["choices", "question"]);
    expect(args).not.toHaveProperty("questions");
    expect(typeof args.question).toBe("string");
    expect(args.choices).toEqual([ASSET_CONFIRM_YES, ASSET_CONFIRM_NO]);
  });

  it("所有 stage 都满足 schema：question 非空、choices ≤4 且均为字符串", () => {
    const stages: FormStage[] = ["asset_confirm", "team", "agent_select", "task_select"];
    for (const stage of stages) {
      const args = buildClarifyArgs(fd(stage, { teams: makeTeams(7, 7, 7) }));
      expect(typeof args.question).toBe("string");
      expect(args.question.length).toBeGreaterThan(0);
      if (args.choices !== undefined) {
        expect(args.choices.length).toBeLessThanOrEqual(HERMES_MAX_CHOICES);
        expect(args.choices.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
      }
    }
  });

  it("选项为 0 时退化成开放式提问，而不是抛异常", () => {
    const args = buildClarifyArgs(fd("team", { teams: [] }));
    expect(args.choices).toBeUndefined();
    expect(args.question.length).toBeGreaterThan(0);
  });

  it("选项只有 1 个时照常单选项提问", () => {
    const args = buildClarifyArgs(fd("team", { teams: makeTeams(1, 1, 1) }));
    expect(args.choices).toHaveLength(1);
  });
});

describe("hermes clarify 分页（4 项硬上限）", () => {
  it("非末页保留 '更多' 尾槽且总选项不超过 4", () => {
    const args = buildClarifyArgs(fd("team", { teams: makeTeams(7, 1, 1), pageIndex: 0 }));
    expect(args.choices!.length).toBeLessThanOrEqual(HERMES_MAX_CHOICES);
    expect(args.choices!.some((c) => c.startsWith(MORE_LABEL))).toBe(true);
  });

  it("末页不含 '更多'，页码越界会被钳制", () => {
    const args = buildClarifyArgs(fd("team", { teams: makeTeams(5, 1, 1), pageIndex: 99 }));
    expect(args.choices!.some((c) => c.startsWith(MORE_LABEL))).toBe(false);
  });

  it("agent / task stage 同样受 4 项上限约束", () => {
    const agentArgs = buildClarifyArgs(fd("agent_select", { teams: makeTeams(1, 9, 1) }));
    const taskArgs = buildClarifyArgs(
      fd("task_select", { teams: makeTeams(1, 1, 9), selectedTeamId: "team-00000001" }),
    );
    expect(agentArgs.choices!.length).toBeLessThanOrEqual(HERMES_MAX_CHOICES);
    expect(taskArgs.choices!.length).toBeLessThanOrEqual(HERMES_MAX_CHOICES);
  });
});

describe("hermes 表单响应（OpenAI chat/completions 传输）", () => {
  it("流式响应里 tool_call 名是 clarify，arguments 是合法 JSON", async () => {
    const res = buildFormResponse(fd("asset_confirm", { stream: true, modelId: "mock-model" }));
    const text = await res.text();
    expect(text).toContain(`"name":"${TOOL_NAME}"`);
    const chunks = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l.slice(6) !== "[DONE]")
      .map((l) => JSON.parse(l.slice(6)));
    const decl = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name);
    expect(decl.choices[0].delta.tool_calls[0].function.name).toBe(TOOL_NAME);
    const argsChunk = chunks.find(
      (c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments,
    );
    const args = JSON.parse(argsChunk.choices[0].delta.tool_calls[0].function.arguments);
    expect(args.question.length).toBeGreaterThan(0);
    expect(args.choices.length).toBeLessThanOrEqual(HERMES_MAX_CHOICES);
  });

  it("非流式响应是标准 chat.completion 形状", async () => {
    const res = buildFormResponse(fd("asset_confirm", { stream: false }));
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.tool_calls[0].function.name).toBe(TOOL_NAME);
    expect(body.choices[0].finish_reason).toBe("tool_calls");
  });
});
