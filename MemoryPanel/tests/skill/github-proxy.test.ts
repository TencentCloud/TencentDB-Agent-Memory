import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerSkillProxyRoutes } from "../../src/panel/http/routes/skill/proxy.js";
import type { PanelDeps } from "../../src/panel/panel-deps.js";
const ok = (data: unknown) => ({
  code: 0,
  message: "ok",
  request_id: "test",
  data,
});
function fixture(
  options: {
    valid?: boolean;
    member?: boolean;
    owner?: string;
    agentTeam?: string;
  } = {},
) {
  const invoke = vi.fn(async () => ok({ installed: true }));
  const meta = vi.fn(async (action: string) => {
    if (action === "auth/verify")
      return ok({
        valid: options.valid ?? true,
        user: { user_id: "authenticated-user" },
      });
    if (action === "team-member/get")
      return options.member === false
        ? { ...ok(null), code: 404 }
        : ok({ user_id: "authenticated-user" });
    if (action === "agent/get")
      return ok({
        owner_user_id: options.owner ?? "authenticated-user",
        team_id: options.agentTeam ?? "team-a",
      });
    throw new Error(action);
  });
  const deps = {
    instanceRegistry: {
      resolve: (id: string) => ({
        instance_id: id,
        gateway_endpoint: "http://kernel.test",
        api_key: "internal",
      }),
    },
    skillKernel: { invoke },
    metaKernel: { invoke: meta },
  } as unknown as PanelDeps;
  const app = new Hono();
  registerSkillProxyRoutes(app, deps);
  const request = (
    action = "github/apply",
    body: unknown = {
      team_id: "team-a",
      agent_id: "agent-a",
      user_id: "forged",
    },
  ) =>
    app.request("/skill/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Tdai-Service-Id": "service-a",
        "X-Tdai-User-Key": "user-key",
      },
      body: JSON.stringify(body),
    });
  return { request, invoke, meta };
}
describe("GitHub Skill Panel authorization", () => {
  it.each(["github/preview", "github/apply", "github/detach"])(
    "binds %s to the authenticated user and instance",
    async (action) => {
      const f = fixture();
      const response = await f.request(action);
      expect(response.status).toBe(200);
      expect(f.invoke).toHaveBeenCalledWith(
        action,
        {
          team_id: "team-a",
          agent_id: "agent-a",
          user_id: "authenticated-user",
        },
        expect.objectContaining({
          instanceId: "service-a",
          userKey: "user-key",
        }),
      );
    },
  );
  it.each([
    { valid: false },
    { member: false },
    { owner: "another-user" },
    { agentTeam: "team-b" },
  ])("blocks unauthorized access: %j", async (options) => {
    const f = fixture(options);
    const response = await f.request();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { team_id: "team-a" }])(
    "rejects invalid scope %j",
    async (body) => {
      const f = fixture();
      const response = await f.request("github/preview", body);
      expect(response.status).toBe(400);
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );
});
