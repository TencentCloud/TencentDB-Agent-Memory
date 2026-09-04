import { describe, expect, it } from "vitest";
import {
  authorizeV3DataPlaneScope,
  handleV2Route,
  isV3DataPlanePath,
  selectV3DataPlaneAuthMode,
} from "./v2-router.js";

function metadataService(overrides: Record<string, unknown> = {}) {
  return {
    isConfiguredMemorySystemUserKey: () => false,
    verifyAuth: async (key: string) => key === "sk-user-1"
      ? { user_id: "principal-1", user_type: "normal" }
      : null,
    getTeamMember: async () => ({ status: "active" }),
    getAgentById: async () => ({ team_id: "team-1", status: "active" }),
    ...overrides,
  };
}

describe("v3 data-plane per-user authorization", () => {
  it("recognizes only existing L0-L3 routes", () => {
    expect(isV3DataPlanePath("/v3/conversation/add")).toBe(true);
    expect(isV3DataPlanePath("/v3/core/read")).toBe(true);
    expect(isV3DataPlanePath("/v3/meta/team/get")).toBe(false);
    expect(isV3DataPlanePath("/v3/skill/query")).toBe(false);
  });

  it("fails closed when neither per-user nor configured service auth exists", () => {
    expect(selectV3DataPlaneAuthMode("/v3/conversation/add", "sk-user-1", false))
      .toBe("user_key");
    expect(selectV3DataPlaneAuthMode("/v3/conversation/add", "", true))
      .toBe("service_key");
    expect(selectV3DataPlaneAuthMode("/v3/conversation/add", "", false))
      .toBe("reject");
    expect(selectV3DataPlaneAuthMode("/v3/meta/team/get", "", false))
      .toBe("not_applicable");
    expect(selectV3DataPlaneAuthMode("/v2/conversation/add", "sk-user-1", false))
      .toBe("not_applicable");
  });

  it("accepts a user in the requested active team and agent scope", async () => {
    await expect(authorizeV3DataPlaneScope(
      "sk-user-1",
      { userId: "principal-1", teamId: "team-1", agentId: "agent-1" },
      metadataService(),
    )).resolves.toEqual({ ok: true, userId: "principal-1" });
  });

  it("rejects an invalid user key", async () => {
    await expect(authorizeV3DataPlaneScope(
      "bad-key",
      { userId: "principal-1", teamId: "team-1", agentId: "agent-1" },
      metadataService(),
    )).resolves.toMatchObject({ ok: false, status: 401, reason: "invalid_user_key" });
  });

  it("rejects a different requested user", async () => {
    await expect(authorizeV3DataPlaneScope(
      "sk-user-1",
      { userId: "principal-2", teamId: "team-1", agentId: "agent-1" },
      metadataService(),
    )).resolves.toMatchObject({ ok: false, status: 403, reason: "user_id_mismatch" });
  });

  it("rejects a mismatched user before resolving memory storage", async () => {
    let storeResolved = false;
    let response: { status: number; body: unknown } | undefined;
    const request = {
      url: "/v3/conversation/search",
      headers: {
        authorization: "Bearer sk-user-1",
        "x-tdai-service-id": "default",
        "x-tdai-user-key": "sk-user-1",
      },
    };

    const handled = await handleV2Route(
      request as never,
      {} as never,
      "/v3/conversation/search",
      "POST",
      async () => ({
        team_id: "team-1",
        agent_id: "agent-1",
        user_id: "principal-2",
        query: "private fact",
      }) as never,
      (_res, status, body) => { response = { status, body }; },
      {
        getStore: () => {
          storeResolved = true;
          return undefined;
        },
        getEmbedding: () => undefined,
        getStorage: () => undefined,
        getMetadataService: async () => metadataService() as never,
        deployMode: "standalone",
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      },
    );

    expect(handled).toBe(true);
    expect(response).toMatchObject({ status: 403 });
    expect(response?.body).toMatchObject({ message: "forbidden: user_id_mismatch" });
    expect(storeResolved).toBe(false);
  });

  it("rejects inactive team membership before checking the agent", async () => {
    let agentLookedUp = false;
    const service = metadataService({
      getTeamMember: async () => ({ status: "inactive" }),
      getAgentById: async () => {
        agentLookedUp = true;
        return { team_id: "team-1", status: "active" };
      },
    });

    const result = await authorizeV3DataPlaneScope(
      "sk-user-1",
      { userId: "principal-1", teamId: "team-1", agentId: "agent-1" },
      service,
    );

    expect(result).toMatchObject({ ok: false, status: 403, reason: "not_team_member" });
    expect(agentLookedUp).toBe(false);
  });

  it("rejects an inactive agent or an agent from another team", async () => {
    for (const agent of [
      { team_id: "team-2", status: "active" },
      { team_id: "team-1", status: "archived" },
    ]) {
      await expect(authorizeV3DataPlaneScope(
        "sk-user-1",
        { userId: "principal-1", teamId: "team-1", agentId: "agent-1" },
        metadataService({ getAgentById: async () => agent }),
      )).resolves.toMatchObject({ ok: false, status: 403, reason: "agent_scope_mismatch" });
    }
  });
});
