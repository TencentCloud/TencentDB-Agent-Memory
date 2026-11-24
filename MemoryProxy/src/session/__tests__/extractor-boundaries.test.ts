import { describe, expect, it } from "vitest";
import {
  BYPASS_MARKER, MORE_MARKER, extractFromOptionText, extractStructured,
  extractTeamFromOptionText, resolveAgent, resolveTask,
} from "../extractor.js";
import { MORE_LABEL, SKIP_LABEL } from "../form.js";
import type { TeamOption } from "../types.js";

const teams: TeamOption[] = [
  {
    team_id: "team-11111111", team_name: "Platform",
    agents: [{ agent_id: "agent-11111111", agent_name: "Coder" }],
    tasks: [{ task_id: "task-11111111", task_name: "Fix tests" }],
  },
  {
    team_id: "team-22222222", team_name: "Platform Infrastructure",
    agents: [
      { agent_id: "agent-22222222", agent_name: "Coder" },
      { agent_id: "agent-33333333", agent_name: "Reviewer" },
    ],
    tasks: [{ task_id: "task-22222222", task_name: "Review tests" }],
  },
];

const answer = (agent: string, task?: string) => JSON.stringify({
  result: { type: "multi_question_result", questions: [
    { id: "agent", answer: agent }, ...(task ? [{ id: "task", answer: task }] : []),
  ] },
});

describe("session selection stays within the selected team", () => {
  it("resolves a duplicate agent name only inside the selected team", () => {
    expect(extractFromOptionText(answer("Coder", "Review tests"), teams, teams[1].team_id))
      .toEqual({ agent_id: "agent-22222222", task_id: "task-22222222" });
  });

  it("rejects missing or unknown team selection when multiple teams exist", () => {
    expect(extractFromOptionText(answer("Coder"), teams)).toBeNull();
    expect(extractFromOptionText(answer("Coder"), teams, "missing-team")).toBeNull();
  });

  it("does not select an agent or task from another team", () => {
    expect(extractFromOptionText(answer("Reviewer"), teams, teams[0].team_id)).toBeNull();
    expect(extractFromOptionText(answer("Coder", "Review tests"), teams, teams[0].team_id))
      .toEqual({ agent_id: "agent-11111111", task_id: undefined });
  });

  it("supports CodeBuddy XML with q1/q2 fields", () => {
    const xml = '<question_answer><question_item id="q1"><answers>Reviewer</answers></question_item>'
      + '<question_item id="q2"><answers>Review tests</answers></question_item></question_answer>';
    expect(extractFromOptionText(xml, teams, teams[1].team_id))
      .toEqual({ agent_id: "agent-33333333", task_id: "task-22222222" });
  });

  it.each([[SKIP_LABEL, BYPASS_MARKER], [MORE_LABEL, MORE_MARKER]])(
    "recognizes explicit navigation choice %s", (label, marker) => {
      expect(extractFromOptionText(answer(label), teams, teams[0].team_id))
        .toEqual({ agent_id: marker });
    },
  );

  it("does not bypass just because unselected options contain the skip label", () => {
    const content = JSON.stringify({
      type: "multi_question_result",
      questions: [{ id: "agent", answer: "Coder", options: ["Coder", SKIP_LABEL] }],
    });
    expect(extractFromOptionText(content, teams, teams[0].team_id)?.agent_id).toBe("agent-11111111");
  });

  it("treats an explicit task skip independently from agent selection", () => {
    expect(extractFromOptionText(answer("Coder", "skip"), teams, teams[0].team_id))
      .toEqual({ agent_id: "agent-11111111", task_id: undefined });
  });
});

describe("team and structured selection", () => {
  it("uses the longest team name for substring matching", () => {
    expect(extractTeamFromOptionText("I choose Platform Infrastructure", teams)).toBe("team-22222222");
  });

  it("uses the ID suffix to disambiguate identical team names", () => {
    const duplicateNames = teams.map((team) => ({ ...team, team_name: "Team" }));
    expect(extractTeamFromOptionText("Team (22222222)", duplicateNames)).toBe("team-22222222");
  });

  it("parses a single q1 XML answer as the team", () => {
    expect(extractTeamFromOptionText(
      '<question_item id="q1"><answers>Platform Infrastructure</answers></question_item>', teams,
    )).toBe("team-22222222");
  });

  it("does not synthesize a team when none are available", () => {
    expect(extractTeamFromOptionText("Platform", [])).toBeNull();
    expect(extractTeamFromOptionText("unrecognized", teams)).toBeNull();
  });

  it.each(["0", "skip", "SKIP"])("omits an explicitly skipped task (%s)", (task) => {
    expect(extractStructured(`agent：agent-id\ntask=${task}`))
      .toEqual({ agent_id: "agent-id", task_id: undefined });
  });

  it("requires an explicit structured agent field", () => {
    expect(extractStructured("please review tests")).toBeNull();
    expect(extractStructured("task: task-id")).toBeNull();
  });

  it("resolves numeric indexes within the selected team", () => {
    expect(resolveAgent("2", teams, teams[1].team_id)).toBe("agent-33333333");
    expect(resolveTask("1", teams, undefined, teams[1].team_id)).toBe("task-22222222");
    expect(resolveAgent("2", teams, teams[0].team_id)).toBe("2");
  });

  it("keeps digit-prefixed ULIDs intact instead of interpreting them as indexes", () => {
    const ulid = "01KWZ81YGGCCN2FEY0JB85CZ69";
    expect(resolveAgent(ulid, teams, teams[1].team_id)).toBe(ulid);
    expect(resolveTask(ulid, teams, undefined, teams[1].team_id)).toBe(ulid);
  });
});
