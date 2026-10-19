/**
 * The user key sent in `x-tdai-user-key` must never become an upstream credential, also for
 * groups that pass the client's own key through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { installFetch, jsonResponse, makeApp, makeConfig, resetPoolState } from "./test-harness.js";

const SPACE = "sp-key";

function rows(agent: string, mode: InstanceUpstreamRow["mode"]): InstanceUpstreamRow[] {
  return [
    { group_id: "d", group_type: "default", name: "d", agents: ["pi"], enabled: true, mode: "official", base_url: "", api_key: "", model_id: "" },
    { group_id: "c", group_type: "custom", name: "c", agents: [agent], enabled: true, mode, base_url: "http://custom.test/api", api_key: "group-key", model_id: "" },
  ];
}

describe("x-tdai-user-key and custom_passthrough groups", () => {
  beforeEach(() => resetPoolState());
  afterEach(() => vi.unstubAllGlobals());

  it("anthropic: the client's own x-api-key goes upstream, not the user key", async () => {
    __primeCacheForTests(SPACE, rows("claude-code", "custom_passthrough"));
    const { upstreamCalls } = installFetch(() => jsonResponse({ id: "m", type: "message", role: "assistant", content: [], usage: {} }));
    await makeApp(makeConfig()).request(`/claude-code/${SPACE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", "x-api-key": "client-own-key" },
      body: JSON.stringify({ model: "claude-x", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.headers["x-api-key"]).toBe("client-own-key");
    expect(JSON.stringify(upstreamCalls[0]!.headers)).not.toContain("sk-mem-user");
  });

  it("openai chat: the client's own bearer goes upstream, not the user key", async () => {
    __primeCacheForTests(SPACE, rows("codebuddy", "custom_passthrough"));
    const { upstreamCalls } = installFetch(() => jsonResponse({ id: "c", object: "chat.completion", choices: [], usage: {} }));
    await makeApp(makeConfig()).request(`/codebuddy/${SPACE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", authorization: "Bearer client-own-key" },
      body: JSON.stringify({ model: "gpt-x", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer client-own-key");
    expect(JSON.stringify(upstreamCalls[0]!.headers)).not.toContain("sk-mem-user");
  });

  it("anthropic without the header: unchanged, the client key is used", async () => {
    __primeCacheForTests(SPACE, rows("claude-code", "custom_passthrough"));
    const { upstreamCalls } = installFetch(() => jsonResponse({ id: "m", type: "message", role: "assistant", content: [], usage: {} }));
    await makeApp(makeConfig()).request(`/claude-code/${SPACE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-own-key" },
      body: JSON.stringify({ model: "claude-x", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(upstreamCalls[0]!.headers["x-api-key"]).toBe("client-own-key");
  });
});
