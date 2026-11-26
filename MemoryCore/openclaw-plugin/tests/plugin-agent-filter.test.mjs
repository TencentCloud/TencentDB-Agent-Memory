import assert from "node:assert/strict";
import test from "node:test";

import register from "../dist/index.js";

function createApi() {
  const tools = [];
  const hooks = new Map();
  const api = {
    pluginConfig: {
      server: {
        url: "http://127.0.0.1:8420",
        apiKey: "test",
        instanceId: "default",
        teamId: "team-test",
        agentId: "agent-remote",
        userId: "user-test",
      },
      agentFilter: { include: ["coding-agent"] },
      capture: { enabled: true },
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    registerTool(factory, options) {
      tools.push({ factory, options });
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
  };

  register(api);
  return { tools, hooks };
}

test("hides all remote memory tools from unlisted runtime agents", () => {
  const { tools } = createApi();

  assert.equal(tools.length, 3);
  for (const { factory } of tools) {
    assert.equal(factory({ agentId: "main" }), null);
    assert.notEqual(factory({ agentId: "coding-agent" }), null);
  }
});

test("skips recall and capture hooks for unlisted runtime agents", async () => {
  const { hooks } = createApi();
  const recall = hooks.get("before_prompt_build");
  const capture = hooks.get("agent_end");

  assert.equal(typeof recall, "function");
  assert.equal(typeof capture, "function");

  assert.equal(
    await recall({}, { agentId: "main", sessionKey: "agent:main:test" }),
    undefined,
  );
  assert.equal(
    await capture(
      { success: true, messages: [{ role: "user", content: "must not upload" }] },
      { agentId: "main", sessionKey: "agent:main:test" },
    ),
    undefined,
  );
});
