import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const endpoint = (process.env.TDAI_MEMORY_ENDPOINT || "http://127.0.0.1:18420").replace(/\/+$/, "");
const apiKey = process.env.TDAI_MEMORY_API_KEY || "local";
const serviceId = process.env.TDAI_MEMORY_SERVICE_ID || "default";
const teamId = process.env.TDAI_MEMORY_TEAM_ID || "default";
const agentId = process.env.TDAI_MEMORY_AGENT_ID || "opencode";
const userId = process.env.TDAI_MEMORY_USER_ID || "default";
const stateDir = await mkdtemp(join(tmpdir(), "tdai-opencode-e2e-"));
const sessionId = `opencode-e2e-${Date.now()}-${process.pid}`;
const marker = `TDAI_OPENCODE_E2E_${Date.now()}_${process.pid}`;
const previous = { ...process.env };

Object.assign(process.env, {
  TDAI_MEMORY_ENDPOINT: endpoint,
  TDAI_MEMORY_API_KEY: apiKey,
  TDAI_MEMORY_SERVICE_ID: serviceId,
  TDAI_MEMORY_TEAM_ID: teamId,
  TDAI_MEMORY_AGENT_ID: agentId,
  TDAI_MEMORY_USER_ID: userId,
  TDAI_OPENCODE_STATE_DIR: stateDir,
  TDAI_OPENCODE_SKILL_ENABLED: "false",
});

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  "x-tdai-service-id": serviceId,
};
const isolation = { team_id: teamId, agent_id: agentId, user_id: userId };

async function post(path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let envelope;
  try { envelope = JSON.parse(text); }
  catch { throw new Error(`${path} returned HTTP ${response.status}: ${text}`); }
  if (!response.ok || envelope.code !== 0) {
    throw new Error(`${path} failed: ${envelope.message || `HTTP ${response.status}`}`);
  }
  return envelope.data ?? {};
}

function toolJson(value) {
  const lines = value.split("\n");
  return JSON.parse(lines.slice(2, -1).join("\n"));
}

let capturedIds = [];
try {
  const { createPlugin } = await import("../dist/plugin.js");
  const messages = [
    {
      info: { id: `${sessionId}-user`, role: "user", time: { created: Date.now() - 2 } },
      parts: [{ type: "text", text: `Remember this local adapter test marker: ${marker}` }],
    },
    {
      info: {
        id: `${sessionId}-assistant`,
        parentID: `${sessionId}-user`,
        role: "assistant",
        finish: "stop",
        time: { created: Date.now() - 1, completed: Date.now() },
      },
      parts: [{ type: "text", text: `Acknowledged ${marker}` }],
    },
  ];
  const logs = [];
  const hooks = await createPlugin({
    directory: process.cwd(),
    worktree: process.cwd(),
    client: {
      app: { log: async (entry) => { logs.push(entry.body); } },
      session: { messages: async () => ({ data: messages }) },
    },
  });

  assert.equal(typeof hooks.event, "function");
  assert.equal(typeof hooks["chat.message"], "function");
  assert.equal(typeof hooks["experimental.chat.system.transform"], "function");
  assert.deepEqual(Object.keys(hooks.tool).sort(), [
    "tdai_conversation_search",
    "tdai_memory_search",
    "tdai_memory_status",
    "tdai_skill_read",
    "tdai_skill_search",
  ]);

  const status = toolJson(await hooks.tool.tdai_memory_status.execute({}, { abort: new AbortController().signal }));
  assert.equal(status.reachable, true);

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } });

  const search = await post("/v3/conversation/search", {
    ...isolation,
    session_id: sessionId,
    query: marker,
    limit: 20,
  });
  assert.equal(search.messages?.length, 2, "repeated idle must not duplicate a captured turn");
  assert(search.messages.every((item) => item.content.includes(marker)));
  capturedIds = search.messages.map((item) => item.id).filter(Boolean);
  const nativeSearch = await hooks.tool.tdai_conversation_search.execute(
    { query: marker, limit: 20, session_id: sessionId },
    { abort: new AbortController().signal },
  );
  assert(nativeSearch.includes(marker), "the native conversation search tool must reach the real Gateway");

  await hooks["chat.message"](
    { sessionID: `${sessionId}-recall` },
    { parts: [{ type: "text", text: marker }] },
  );
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: `${sessionId}-recall` }, output);
  assert(output.system.join("\n").includes(marker), "a new session must receive the persisted L0 marker");
  assert(logs.some((entry) => entry.message === "TencentDB Agent Memory initialized"));

  console.log(JSON.stringify({
    opencodeHooks: true,
    nativeTools: Object.keys(hooks.tool).length,
    capturedMessages: search.messages.length,
    repeatedIdleDeduplicated: true,
    crossSessionRecall: true,
    endpoint,
  }));
} finally {
  if (capturedIds.length > 0) {
    await post("/v3/conversation/delete", {
      ...isolation,
      session_id: sessionId,
      message_ids: capturedIds,
    }).catch((error) => console.error(`E2E cleanup warning: ${error.message}`));
    const remaining = await post("/v3/conversation/search", {
      ...isolation,
      session_id: sessionId,
      query: marker,
      limit: 20,
    });
    assert.equal(remaining.messages?.length ?? 0, 0, "E2E cleanup must remove its test messages");
  }
  await rm(stateDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}
