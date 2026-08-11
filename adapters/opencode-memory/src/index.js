/**
 * OpenCode adapter for TencentDB Agent Memory.
 *
 * What it does
 * - On `session.idle`, persists the conversation turn into the Memory Gateway (L0 conversation).
 * - Exposes a `memory_search` tool so the agent can recall persistent memories mid-session.
 *
 * Gateway
 * - Default endpoint: http://127.0.0.1:8420 (the memory-tencentdb Gateway sidecar).
 * - Override with the OPCODE_MEMORY_GATEWAY_URL environment variable.
 * - API contract follows MemoryTencentdbSdkClient (MemoryCore/hermes-plugin/memory/memory_tencentdb/client.py):
 *   POST /v3/conversation/add and POST /v3/atomic/search.
 */

const GATEWAY_URL = process.env.OPCODE_MEMORY_GATEWAY_URL || "http://127.0.0.1:8420";
const TEAM_ID = process.env.OPCODE_MEMORY_TEAM_ID || "default";
const AGENT_ID = process.env.OPCODE_MEMORY_AGENT_ID || "opencode";
const USER_ID = process.env.OPCODE_MEMORY_USER_ID || "default";

async function gateway(path, body) {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPCODE_MEMORY_API_KEY || "local"}`,
      "x-tdai-service-id": "opencode",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`memory gateway ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function captureSession(ctx, sessionID) {
  let transcript = [];
  try {
    // OpenCode client exposes session chat messages; fall back to event metadata
    // when the transcript is not yet flushed.
    const chat = await ctx.client.session.chat({ sessionID });
    transcript = (chat || []).slice(-20).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text || m.content || "",
      timestamp: Math.floor(Date.now() / 1000),
    }));
  } catch {
    transcript = [
      {
        role: "user",
        content: `session ${sessionID} finished`,
        timestamp: Math.floor(Date.now() / 1000),
      },
    ];
  }
  if (!transcript.length) return;
  await gateway("/v3/conversation/add", {
    team_id: TEAM_ID,
    agent_id: AGENT_ID,
    user_id: USER_ID,
    session_id: sessionID,
    messages: transcript,
  });
}

export const memoryPlugin = async (ctx) => ({
  event: async ({ event }) => {
    if (event.type === "session.idle") {
      await captureSession(ctx, event.properties.sessionID);
    }
  },
  tool: {
    memory_search: {
      description: "Search persistent memories from TencentDB Agent Memory.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keywords, e.g. '招商银行 净息差'" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
      execute: async ({ query, limit }) => {
        const data = await gateway("/v3/atomic/search", {
          team_id: TEAM_ID,
          agent_id: AGENT_ID,
          user_id: USER_ID,
          query,
          limit: limit || 5,
        });
        return JSON.stringify(data, null, 2);
      },
    },
  },
});

export default memoryPlugin;
