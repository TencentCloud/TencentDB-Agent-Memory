import { describe, expect, it } from "vitest";
import { buildFormResponse, REASONING_PLACEHOLDER, TOOL_NAME, TOOLCALL_PREFIX } from "../form.js";

const teams = [{
  team_id: "team-12345678",
  team_name: "Team A",
  agents: [{ agent_id: "agent-12345678", agent_name: "Agent A" }],
  tasks: [{ task_id: "task-12345678", task_name: "Task A" }],
}];

describe("Cursor AskQuestion form", () => {
  it("builds the captured native schema in non-stream mode", async () => {
    const response = buildFormResponse({ teams, stage: "asset_confirm", modelId: "test", stream: false });
    const body = await response.json() as any;
    const call = body.choices[0].message.tool_calls[0];
    const args = JSON.parse(call.function.arguments);

    expect(call.function.name).toBe(TOOL_NAME);
    expect(call.id.startsWith(TOOLCALL_PREFIX)).toBe(true);
    expect(body.choices[0].message.reasoning_content).toBe(REASONING_PLACEHOLDER);
    expect(args.questions[0]).toMatchObject({
      id: "asset_confirm",
      allow_multiple: false,
    });
    expect(args.questions[0].options[0]).toEqual(expect.objectContaining({ id: expect.any(String), label: expect.any(String) }));
  });

  it("emits tool_calls, usage, and DONE SSE termination", async () => {
    const response = buildFormResponse({ teams, stage: "team", modelId: "test", stream: true });
    const text = await response.text();
    expect(text).toContain(`\"name\":\"${TOOL_NAME}\"`);
    expect(text).toContain(`\"reasoning_content\":\"${REASONING_PLACEHOLDER}\"`);
    expect(text).toContain('\"finish_reason\":\"tool_calls\"');
    expect(text).toContain('\"choices\":[],\"usage\"');
    expect(text).toContain("data: [DONE]\n\n");
  });
});
