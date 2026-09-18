import { beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ProxyConfig } from "../../types.js";

const mocks = vi.hoisted(() => ({ sink: vi.fn(), pin: vi.fn(), pinMany: vi.fn() }));
vi.mock("../../clickhouse.js", () => ({ writeToolCallRow: mocks.sink }));
vi.mock("../../session/store.js", () => ({
  getSessionStore: () => ({
    getBindingRepo: () => null,
    get: (key: string) => key === "claude-code:session" ? {
      status: "initialized", sessionInfo: { user_id: "user", team_id: "team", agent_id: "agent", space_id: "space" },
    } : undefined,
  }),
}));
vi.mock("../../storage/factory.js", () => ({ getProxyStorage: () => ({}) }));
vi.mock("../kv-version-pin-repo.js", () => ({
  KvVersionPinRepo: class { getVersion = mocks.pin; pinMany = mocks.pinMany; },
}));
import { createSkillBridgeHandler } from "../skill-bridge.js";

const config = {
  coreSkill: { endpoint: "http://core", serviceToken: "secret", serviceId: "fallback", timeoutMs: 1000 },
  storage: { enabled: true }, redis: { enabled: false },
} as ProxyConfig;
const detail = JSON.stringify({ code: 0, data: { skill_id: "skl-resolved", version: 2, content: "# private body" } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sink.mockReset();
  mocks.pin.mockResolvedValue(null);
  mocks.pinMany.mockResolvedValue(undefined);
});

async function call(endpoint: string, text: string, status = 200, body: Record<string, unknown> = {}, failFetch = false) {
  const fetcher = vi.fn<typeof fetch>();
  if (failFetch) fetcher.mockRejectedValue(new Error("network unavailable"));
  else fetcher.mockResolvedValue(new Response(text, { status, headers: { "content-type": "application/json" } }));
  const app = new Hono();
  app.all("/skill-bridge/*", createSkillBridgeHandler(config, { fetcher }));
  const result = await app.request(`/skill-bridge/v3/skill/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", "x-conversation-id": "session", "x-tdai-service-id": "space" },
    body: JSON.stringify(body),
  });
  return { result, fetcher };
}

it("records the returned historical version and trusted session identities", async () => {
  const { result, fetcher } = await call("get", detail, 200, { skill_id: "skl-resolved", version: 2, user_id: "forged" });
  expect(await result.text()).toBe(detail);
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ version: 2, user_id: "user", team_id: "team", agent_id: "agent" });
  expect(mocks.sink).toHaveBeenCalledWith(expect.objectContaining({ skillId: "skl-resolved", skillVersion: 2, sessionKey: "claude-code:session", spaceId: "space", agentId: "agent" }));
  expect(JSON.stringify(mocks.sink.mock.calls)).not.toContain("# private body");
});

it("records response version when a session pin overrides the requested version", async () => {
  mocks.pin.mockResolvedValue(2);
  const { fetcher } = await call("get", detail, 200, { skill_id: "skl-resolved", version: 9 });
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).version).toBe(2);
  expect(mocks.sink.mock.calls[0][0].skillVersion).toBe(2);
});

it("records resolved ID for get-by-name without changing pin behavior", async () => {
  const { result } = await call("get-by-name", detail, 200, { skill_name: "example" });
  expect(result.status).toBe(200);
  expect(mocks.sink.mock.calls[0][0]).toMatchObject({ executedEndpoint: "get-by-name", skillId: "skl-resolved", skillVersion: 2 });
  expect(mocks.pin).not.toHaveBeenCalled();
  expect(mocks.pinMany).not.toHaveBeenCalled();
});

it.each([
  [404, detail], [200, '{"code":42}'], [200, "bad JSON"],
  [200, '{"code":0,"data":{"skill_id":"skl-a","content":"body"}}'],
])("preserves failure/insufficient response (%s, %s) without loaded fields", async (status, text) => {
  const { result } = await call("get", text, status);
  expect(result.status).toBe(status);
  expect(await result.text()).toBe(text);
  expect(mocks.sink.mock.calls[0][0].skillId).toBeUndefined();
  expect(mocks.sink.mock.calls[0][0].skillVersion).toBeUndefined();
});

it("returns the successful Skill response even if the telemetry sink throws", async () => {
  mocks.sink.mockImplementation(() => { throw new Error("sink unavailable"); });
  const { result } = await call("get", detail);
  expect(result.status).toBe(200);
  expect(await result.text()).toBe(detail);
});

it("records network failure as an attempted call only", async () => {
  const { result } = await call("get", "", 200, {}, true);
  expect(result.status).toBe(502);
  expect(mocks.sink.mock.calls[0][0]).toMatchObject({ upstreamStatus: 0 });
  expect(mocks.sink.mock.calls[0][0].skillVersion).toBeUndefined();
});
