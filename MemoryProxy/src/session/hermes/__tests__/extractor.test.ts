import { describe, it, expect } from "vitest";
import { extractHermesAnswers, HERMES_BYPASS_TEXT } from "../extractor.js";
import {
  extractAgentOnly,
  extractAssetConfirm,
  extractTaskOnly,
  extractTeamFromOptionText,
} from "../../codebuddy/extractor.js";
import { getLastUserMessageText } from "../../codebuddy/cleaner.js";
import type { TeamOption } from "../../types.js";

describe("extractHermesAnswers", () => {
  it("returns null for non-JSON content", () => {
    expect(extractHermesAnswers("plain text answer")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractHermesAnswers("")).toBeNull();
  });

  it("extracts single question user_response", () => {
    const content = JSON.stringify({
      question: "请选择 Team",
      choices_offered: ["Alpha (11112222)", "Beta (33334444)"],
      user_response: "Alpha (11112222)",
    });
    expect(extractHermesAnswers(content)).toBe("Alpha (11112222)");
  });

  it("returns bypass for headless error envelope", () => {
    const content = JSON.stringify({ error: "Clarify tool is not available in this execution context." });
    expect(extractHermesAnswers(content)).toBe(HERMES_BYPASS_TEXT);
  });

  it("returns bypass for timeout", () => {
    const content = JSON.stringify({
      question: "test",
      user_response: "The user did not provide a response within the time limit. Use your best judgement.",
    });
    expect(extractHermesAnswers(content)).toBe(HERMES_BYPASS_TEXT);
  });

  it("returns bypass for oneshot auto-answer", () => {
    const content = JSON.stringify({
      question: "test",
      user_response: "[oneshot mode: no user available. auto-answering.]",
    });
    expect(extractHermesAnswers(content)).toBe(HERMES_BYPASS_TEXT);
  });

  it("returns bypass for timed_out batch", () => {
    const content = JSON.stringify({
      responses: [{ question: "q1", user_response: "a1" }],
      timed_out: true,
    });
    expect(extractHermesAnswers(content)).toBe(HERMES_BYPASS_TEXT);
  });

  it("extracts batch responses joined with |", () => {
    const content = JSON.stringify({
      responses: [
        { question: "q1", user_response: "a1" },
        { question: "q2", user_response: "a2" },
      ],
    });
    expect(extractHermesAnswers(content)).toBe("a1 | a2");
  });

  it("returns empty string for valid envelope but no user_response", () => {
    const content = JSON.stringify({ question: "test", user_response: "" });
    expect(extractHermesAnswers(content)).toBe("");
  });

  it("handles multi_select user_response array", () => {
    const content = JSON.stringify({
      question: "test",
      user_response: ["opt1", "opt2"],
    });
    expect(extractHermesAnswers(content)).toBe("opt1 | opt2");
  });
});

const teams: TeamOption[] = [{
  team_id: "team-alpha-11112222",
  team_name: "Alpha",
  agents: [
    { agent_id: "agent-one-33334444", agent_name: "One" },
    { agent_id: "agent-two-55556666", agent_name: "Two" },
  ],
  tasks: [
    { task_id: "task-one-77778888", task_name: "First" },
    { task_id: "task-two-99990000", task_name: "Second" },
  ],
}, {
  team_id: "team-beta-22223333",
  team_name: "Beta",
  agents: [],
  tasks: [],
}];

function clarifyResult(userResponse: string, choices: string[]): string {
  return JSON.stringify({ question: "pick one or 跳过", choices_offered: choices, user_response: userResponse });
}

describe("Hermes answers in the CodeBuddy state machine", () => {
  it("recognizes Hermes session-init tool results", () => {
    const content = clarifyResult("Beta (22223333)", ["Alpha (11112222)", "Beta (22223333)"]);
    expect(getLastUserMessageText([{ role: "tool", tool_call_id: "call_hermes_session_init_1", content }])).toBe(content);
  });

  it("extracts only the selected team from the clarify envelope", () => {
    const content = clarifyResult("Beta (22223333)", ["Alpha (11112222)", "Beta (22223333)"]);
    expect(extractTeamFromOptionText(content, teams)).toBe("team-beta-22223333");
  });

  it("extracts selected agent and task without matching echoed choices", () => {
    const agent = clarifyResult("Two (55556666)", ["One (33334444)", "Two (55556666)"]);
    const task = clarifyResult("Second (99990000)", ["First (77778888)", "Second (99990000)"]);
    expect(extractAgentOnly(agent, teams, teams[0].team_id)).toBe("agent-two-55556666");
    expect(extractTaskOnly(task, teams, teams[0].team_id)).toBe("task-two-99990000");
  });

  it("does not confuse echoed yes/no choices", () => {
    expect(extractAssetConfirm(clarifyResult("否，本次不关联", ["是，关联团队资产", "否，本次不关联"]))).toBe(false);
  });
});
