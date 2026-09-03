/** Local-only Cursor UI E2E harness. Uses fake metadata and a fake upstream. */

import { serve } from "@hono/node-server";
import { buildConfig } from "../../../src/config.js";
import { createApp } from "../../../src/server.js";
import { setMetadataClient } from "../../../src/meta/client.js";

const metadata = {
  listTeams: async () => [
    { team_id: "team-11111111", name: "Cursor Test Team", status: "active" },
    { team_id: "team-22222222", name: "Cursor Second Team", status: "active" },
  ],
  listAgents: async (teamId: string) => [
    { agent_id: "agent-11111111", team_id: teamId, name: "Cursor Test Agent", status: "active" },
    { agent_id: "agent-22222222", team_id: teamId, name: "Cursor Second Agent", status: "active" },
  ],
  listTasks: async (teamId: string) => [
    { task_id: "task-11111111", team_id: teamId, title: "Cursor Test Task", status: "running" },
    { task_id: "task-22222222", team_id: teamId, title: "Cursor Second Task", status: "running" },
  ],
  getAgent: async (agentId: string) => ({
    agent_id: agentId,
    team_id: "team-11111111",
    name: "Cursor Test Agent",
    description: "Local E2E agent fixture",
    prompt: "This is a local Cursor adapter E2E fixture.",
    status: "active",
  }),
  getTask: async (taskId: string) => ({
    task_id: taskId,
    team_id: "team-11111111",
    title: "Cursor Test Task",
    description: "Local E2E task fixture",
    status: "running",
  }),
  appendParticipationLog: async () => ({ id: "local-e2e-participation" }),
};

setMetadataClient(metadata as any);

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/v3/meta/config/user/get")) {
    return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const completion = {
    id: "cursor-e2e-upstream",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "cursor-e2e",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "CURSOR_PROXY_E2E_OK" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  let requestBody: { stream?: boolean } = {};
  try {
    const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof rawBody === "string") requestBody = JSON.parse(rawBody);
  } catch {
    // The harness falls back to a non-stream response for malformed test input.
  }
  if (requestBody.stream) {
    const chunk = {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, delta: { role: "assistant", content: "CURSOR_PROXY_E2E_OK" }, finish_reason: null }],
    };
    const finish = {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    return new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }
  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const config = buildConfig();
config.server.host = "127.0.0.1";
config.server.port = 8096;
config.auth.enabled = false;
config.sessionInit.enabled = true;
config.sessionInit.debugForceUserId = "cursor-e2e-user";
config.injection.enabled = false;
config.extraction.enabled = false;
config.redis.enabled = false;
config.storage.enabled = false;
config.rateLimit.tpm = 0;
config.rateLimit.qpm = 0;
config.upstream.url = "http://cursor-e2e-upstream.invalid/v1";
config.upstream.apiKey = "";
config.tdai.endpoint = "http://cursor-e2e-meta.invalid";

serve({ fetch: createApp(config).fetch, hostname: config.server.host, port: config.server.port }, ({ port }) => {
  console.log(`[cursor-e2e] listening on http://127.0.0.1:${port}`);
  console.log("[cursor-e2e] no external model, memory, or metadata services are used");
});
