import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryClient } from "../src/client.js";
import type { CursorConfig } from "../src/config.js";

const config: CursorConfig = {
  rootDir: "/root",
  gatewayUrl: "https://memory.example.com/",
  gatewayApiKey: "secret",
  serviceId: "service-1",
  teamId: "team-1",
  agentId: "agent-1",
  userId: "user-1",
  taskId: "task-1",
  captureTimeoutMs: 60_000,
  recallTimeoutMs: 2_000,
  executablePath: "/bin/cursor",
  transcriptsRoot: "/cursor/projects",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("已发布 v3 SDK 契约", () => {
  // 真实 SDK 必须发送 service header、完整 isolation 和 session, 且 HTTPS 启用证书校验.
  it("映射 header、body 和 v3 方法", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({
        code: 0,
        message: "ok",
        request_id: "req-1",
        data: {},
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createMemoryClient(config, 1_234);

    await client.addConversation({
      session_id: "cursor:c1",
      messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: "回答" },
      ],
    });
    await client.searchAtomic({ query: "偏好", limit: 5 });
    await client.searchConversation({ query: "原话", session_id: "cursor:c1" });
    await client.listScenarios({});
    await client.readScenario({ path: "project/scene.md" });
    await client.readCore();

    const requests = fetchMock.mock.calls.map(([url, options]) => ({
      url,
      options: options as RequestInit & { dispatcher?: unknown },
      body: JSON.parse(String((options as RequestInit).body)) as Record<string, unknown>,
    }));
    expect(requests.map((request) => request.url)).toEqual([
      "https://memory.example.com/v3/conversation/add",
      "https://memory.example.com/v3/atomic/search",
      "https://memory.example.com/v3/conversation/search",
      "https://memory.example.com/v3/scenario/ls",
      "https://memory.example.com/v3/scenario/read",
      "https://memory.example.com/v3/core/read",
    ]);
    for (const request of requests) {
      expect(request.options.headers).toMatchObject({
        Authorization: "Bearer secret",
        "x-tdai-service-id": "service-1",
      });
      expect(request.options.signal).toBeInstanceOf(AbortSignal);
      expect(request.options).not.toHaveProperty("dispatcher");
      expect(request.body).toMatchObject({
        team_id: "team-1",
        agent_id: "agent-1",
        user_id: "user-1",
        task_id: "task-1",
      });
    }
    expect(requests[0].body).toMatchObject({
      session_id: "cursor:c1",
      messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: "回答" },
      ],
    });
    expect(requests[4].body).toMatchObject({ path: "project/scene.md" });
  });
});
