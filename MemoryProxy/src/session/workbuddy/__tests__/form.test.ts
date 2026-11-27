import { describe, expect, it } from "vitest";
import { buildFormResponse, TOOL_NAME } from "../form.js";

describe("WorkBuddy session-init form", () => {
  it("uses WorkBuddy's AskUserQuestion tool with an array of questions", async () => {
    const response = buildFormResponse({
      teams: [
        { team_id: "team-1", team_name: "Demo Team" },
        { team_id: "team-2", team_name: "Other Team" },
      ],
      stage: "team",
      modelId: "test-model",
      stream: false,
    });
    const body = await response.json();
    const toolCall = body.choices[0].message.tool_calls[0];
    const args = JSON.parse(toolCall.function.arguments);

    expect(toolCall.function.name).toBe(TOOL_NAME);
    expect(TOOL_NAME).toBe("AskUserQuestion");
    expect(args.questions).toHaveLength(1);
    expect(args.questions[0].options[0].label).toContain("Demo Team");
  });
});
