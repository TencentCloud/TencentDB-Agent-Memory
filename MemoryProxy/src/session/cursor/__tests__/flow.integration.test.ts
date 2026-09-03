import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildConfig } from "../../../config.js";
import { createApp } from "../../../server.js";
import { setMetadataClient } from "../../../meta/client.js";

const mockMetadata = {
  listTeams: async () => [
    { team_id: "team-11111111", name: "Team One", status: "active" },
    { team_id: "team-22222222", name: "Team Two", status: "active" },
  ],
  listAgents: async (teamId: string) => teamId === "team-11111111" ? [
    { agent_id: "agent-11111111", team_id: teamId, name: "Agent One", status: "active" },
    { agent_id: "agent-22222222", team_id: teamId, name: "Agent Two", status: "active" },
  ] : [
    { agent_id: "agent-33333333", team_id: teamId, name: "Agent Three", status: "active" },
  ],
  listTasks: async (teamId: string) => [
    { task_id: "task-11111111", team_id: teamId, title: "Task One", status: "running" },
    { task_id: "task-22222222", team_id: teamId, title: "Task Two", status: "running" },
  ],
  getAgent: async (agentId: string) => ({
    agent_id: agentId, team_id: "team-11111111", name: "Agent One", status: "active",
  }),
  getTask: async (taskId: string) => ({
    task_id: taskId, team_id: "team-11111111", title: "Task One", status: "running",
  }),
  appendParticipationLog: async () => ({ id: "participation-1" }),
};

function askTool() {
  return [{ type: "function", function: { name: "AskQuestion", parameters: { type: "object" } } }];
}

describe("Cursor session-init flow", () => {
  afterEach(() => {
    setMetadataClient(null);
    vi.unstubAllGlobals();
  });

  it("runs asset confirmation through team, agent, and task selection", async () => {
    setMetadataClient(mockMetadata as any);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "upstream-ok",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "UPSTREAM_OK" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const config = buildConfig();
    config.auth.enabled = false;
    config.sessionInit.enabled = true;
    config.sessionInit.debugForceUserId = "user-smoke";
    config.injection.enabled = false;
    config.extraction.enabled = false;
    config.redis.enabled = false;
    config.storage.enabled = false;
    config.rateLimit.tpm = 0;
    config.rateLimit.qpm = 0;
    config.upstream.url = "http://upstream.invalid/v1";
    config.upstream.apiKey = "";
    const app = createApp(config);

    // Session state may be persisted by the shared store even when Redis and
    // the optional storage layer are disabled. Use a per-run anchor so this
    // integration test remains repeatable in a long-lived dev container.
    const runAnchor = randomUUID();
    const messages: any[] = [
      { role: "system", content: "cursor system" },
      { role: "user", content: "cursor first-frame metadata" },
      { role: "user", content: [{ type: "text", text: `integration-smoke-${runAnchor}` }] },
    ];

    async function turn(): Promise<any> {
      const response = await app.request("/cursor/default/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer smoke-placeholder" },
        body: JSON.stringify({ model: "cursor-smoke", messages, tools: askTool(), stream: false, user: "account-smoke" }),
      });
      expect(response.status).toBe(200);
      return response.json();
    }

    async function answer(form: any, optionIndex = 0): Promise<void> {
      const assistant = form.choices[0].message;
      const call = assistant.tool_calls[0];
      const args = JSON.parse(call.function.arguments);
      messages.push(assistant);
      messages.push({
        role: "tool",
        name: "AskQuestion",
        tool_call_id: call.id,
        content: [{ type: "text", text: args.questions[0].options[optionIndex].id }],
      });
    }

    const asset = await turn();
    expect(JSON.parse(asset.choices[0].message.tool_calls[0].function.arguments).questions[0].id).toBe("asset_confirm");
    await answer(asset, 0);

    const team = await turn();
    expect(JSON.parse(team.choices[0].message.tool_calls[0].function.arguments).questions[0].id).toBe("team_select");
    await answer(team, 0);

    const agent = await turn();
    expect(JSON.parse(agent.choices[0].message.tool_calls[0].function.arguments).questions[0].id).toBe("agent_select");
    await answer(agent, 0);

    const task = await turn();
    expect(JSON.parse(task.choices[0].message.tool_calls[0].function.arguments).questions[0].id).toBe("task_select");
    await answer(task, 0);

    const completed = await turn();
    expect(completed.choices[0].message.content).toBe("UPSTREAM_OK");
  });
});
