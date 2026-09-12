/**
 * Live Gateway E2E for MiMo Code adapter (no TUI required).
 * Usage: node --import tsx scripts/e2e-mimo-adapter.mjs
 */
import { createMimoCodeMemoryPlugin } from "../src/adapters/mimo-code/index.ts";

const GATEWAY = process.env.MEMORY_TENCENTDB_GATEWAY_URL ?? "http://127.0.0.1:8420";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const gatewayCalls = [];
  const fetchGateway = async (input, init) => {
    gatewayCalls.push(new URL(String(input)).pathname);
    return fetch(input, init);
  };
  const health = await fetchGateway(`${GATEWAY}/health`);
  assert(health.ok, `Gateway unhealthy: ${health.status}`);
  console.log("health", await health.json());

  const logs = [];
  const hooks = await createMimoCodeMemoryPlugin({
    gatewayUrl: GATEWAY,
    allowRemoteGateway: true,
    userId: "e2e-user",
    fetchImpl: fetchGateway,
  })({
    directory: `${process.cwd()}/.e2e-mimo-sandbox`,
    worktree: `${process.cwd()}/.e2e-mimo-sandbox`,
    client: {
      app: {
        log: async (r) => {
          logs.push(r.body);
          console.log("[plugin-log]", r.body.level, r.body.message);
        },
      },
    },
  });

  const marker = `sapphire-green-${Date.now()}`;
  const sessionID = `ses_live_e2e_${Date.now()}`;
  const out = {
    message: { id: "msg_u1", sessionID, role: "user" },
    parts: [
      {
        id: "prt_u1",
        type: "text",
        text: `E2E mark: ${marker} is the secret project color.`,
      },
    ],
  };

  await hooks["chat.message"]?.(
    { sessionID, messageID: "msg_u1" },
    out,
  );
  const system = [];
  await hooks["experimental.chat.system.transform"]?.({ sessionID }, { system });
  console.log("after recall: system sections=", system.length);

  await hooks["session.post"]?.({
    sessionID,
    agentID: "main",
    outcome: "completed",
    trajectory: [
      { role: "user", parts: out.parts },
      {
        role: "assistant",
        parts: [{ type: "text", text: `Noted: ${marker} for the secret project.` }],
      },
    ],
  });
  await hooks.event?.({
    event: {
      type: "session.deleted",
      properties: { info: { id: sessionID } },
    },
  });

  const searchRes = await fetch(`${GATEWAY}/search/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: marker, limit: 5 }),
  });
  const searchBody = await searchRes.json();
  console.log("search status", searchRes.status);
  console.log("search body", JSON.stringify(searchBody).slice(0, 600));
  const warnings = logs.filter((l) => l.level === "warn");
  assert(searchRes.ok, `Conversation search failed: ${searchRes.status}`);
  assert(Number(searchBody.total) >= 2, `Expected at least two captured messages, got ${searchBody.total}`);
  assert(String(searchBody.results ?? "").includes(marker), "Captured marker was not searchable");
  assert(gatewayCalls.includes("/recall"), "Plugin did not call /recall");
  assert(gatewayCalls.includes("/capture"), "Plugin did not call /capture");
  assert(gatewayCalls.includes("/session/end"), "Plugin did not call /session/end");
  assert(
    logs.some((entry) => entry.level === "debug" && entry.message === "Captured completed MiMo Code main-agent turn"),
    "Plugin did not report a completed capture",
  );
  assert(warnings.length === 0, `Plugin emitted warning(s): ${warnings.map((entry) => entry.message).join(", ")}`);
  console.log("plugin warns", warnings.length);
  console.log("LIVE_E2E_OK");
}

main().catch((err) => {
  console.error("LIVE_E2E_FAIL", err);
  process.exit(1);
});
