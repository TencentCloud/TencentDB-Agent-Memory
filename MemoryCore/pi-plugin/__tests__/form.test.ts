import { describe, it, expect } from "vitest";
import { parseFormArgs, formatAnswerXml } from "../form.js";

const teamFormArgs = JSON.stringify({
  title: "会话初始化 — 选择 Team",
  questions: JSON.stringify([{ id: "team", question: "请选择 Team：", options: ["Team A (a1b2c3d4)", "Team B (e5f6g7h8)"], multiSelect: false }]),
});

const agentTaskArgs = JSON.stringify({
  title: "会话初始化 — 选择 Agent 与任务",
  questions: JSON.stringify([
    { id: "agent", question: "请选择 Agent：", options: ["Lucius Fox (0b0wybln)", "default-agent (ao5f94a7)"], multiSelect: false },
    { id: "task", question: "请选择 任务：", options: ["Pi adapter development (hnrorewx)"], multiSelect: false },
  ]),
});

describe("parseFormArgs", () => {
  it("double-decodes a single-question (team) form", () => {
    const f = parseFormArgs(teamFormArgs)!;
    expect(f.title).toBe("会话初始化 — 选择 Team");
    expect(f.questions).toHaveLength(1);
    expect(f.questions[0]).toEqual({ id: "team", question: "请选择 Team：", options: ["Team A (a1b2c3d4)", "Team B (e5f6g7h8)"], multiSelect: false });
  });
  it("double-decodes a two-question (agent+task) form", () => {
    const f = parseFormArgs(agentTaskArgs)!;
    expect(f.questions).toHaveLength(2);
    expect(f.questions[0].id).toBe("agent");
    expect(f.questions[1].id).toBe("task");
  });
  it("returns null for non-JSON string args", () => {
    expect(parseFormArgs("not json")).toBeNull();
  });
  it("returns null when questions field is missing", () => {
    expect(parseFormArgs(JSON.stringify({ title: "x" }))).toBeNull();
  });
  it("accepts the already-parsed object (Pi passes params parsed)", () => {
    const parsed = { title: "会话初始化 — 选择 Team", questions: JSON.stringify([{ id: "team", question: "Q?", options: ["A"], multiSelect: false }]) };
    const f = parseFormArgs(parsed)!;
    expect(f.questions[0].id).toBe("team");
  });
});

describe("formatAnswerXml", () => {
  it("wraps a single answer in question_answer XML", () => {
    const xml = formatAnswerXml([{ id: "team", answer: "Team A (a1b2c3d4)" }]);
    expect(xml).toContain('<question_item id="team">');
    expect(xml).toContain("<answers>Team A (a1b2c3d4)</answers>");
    expect(xml).toContain("<question_answer>");
    expect(xml).toContain("</question_answer>");
  });
  it("emits one question_item per answer (agent+task)", () => {
    const xml = formatAnswerXml([
      { id: "agent", answer: "Lucius Fox (0b0wybln)" },
      { id: "task", answer: "Pi adapter development (hnrorewx)" },
    ]);
    expect(xml.match(/<question_item id="agent">/)).toBeTruthy();
    expect(xml.match(/<question_item id="task">/)).toBeTruthy();
    expect(xml.match(/<question_item/g)?.length).toBe(2);
  });
});
