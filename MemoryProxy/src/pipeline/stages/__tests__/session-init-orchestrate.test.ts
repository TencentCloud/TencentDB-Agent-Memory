import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  getOrRecover: vi.fn(),
  getSessionStore: vi.fn(),
  handleSessionInit: vi.fn(),
  parsePresetIdentity: vi.fn(),
}));

const metadata = vi.hoisted(() => ({
  getMetadataClient: vi.fn(() => ({})),
}));

vi.mock("../../../session/index.js", () => ({
  getSessionStore: session.getSessionStore,
  handleSessionInit: session.handleSessionInit,
  parsePresetIdentity: session.parsePresetIdentity,
}));

vi.mock("../../../meta/client.js", () => ({
  getMetadataClient: metadata.getMetadataClient,
}));

const { stageSessionInitOrchestrate } = await import("../session-init-orchestrate.js");

describe("stageSessionInitOrchestrate", () => {
  beforeEach(() => {
    session.getOrRecover.mockReset().mockResolvedValue(undefined);
    session.getSessionStore.mockReset().mockReturnValue({
      getOrRecover: session.getOrRecover,
    });
    session.handleSessionInit.mockReset().mockResolvedValue({
      intercepted: false,
      sessionInfo: { session_id: "unexpected" },
      bypassed: false,
      justRegistered: false,
    });
    session.parsePresetIdentity.mockReset().mockReturnValue(undefined);
    metadata.getMetadataClient.mockClear();
  });

  it("skips the form state machine when only recovery is allowed", async () => {
    const result = await stageSessionInitOrchestrate({
      agentSourceForState: "dsh",
      sessionKey: "session-ptc",
      userId: "user-1",
      spaceId: "space-1",
      config: { sessionInit: {}, coreSkill: {} },
      kernelUserKey: "user-key",
      headers: {},
      synthesizeMessages: () => [],
      buildRecoverInitResult: async () => ({}),
      buildReqCtx: () => ({}),
      buildInterceptResponse: () => null,
      recoveryMessages: [],
      allowStateMachine: false,
    } as never);

    expect(session.handleSessionInit).not.toHaveBeenCalled();
    expect(result.proceed).toBe(true);
    expect(result.initResult?.sessionInfo).toBeNull();
  });

  it("recovers an existing dsh session without entering the form state machine", async () => {
    const sessionInfo = {
      session_id: "session-ptc",
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
    };
    session.getOrRecover.mockResolvedValue({
      status: "initialized",
      sessionInfo,
      agentDetail: { name: "agent" },
      taskDetail: null,
      bypassed: false,
    });
    const applyRecovery = vi.fn(async () => ({ messages: [{ role: "system", content: "memory" }] }));

    const result = await stageSessionInitOrchestrate({
      agentSourceForState: "dsh",
      sessionKey: "session-ptc",
      userId: "user-1",
      spaceId: "space-1",
      config: { sessionInit: {}, coreSkill: {} },
      kernelUserKey: "user-key",
      headers: {},
      synthesizeMessages: () => [],
      buildRecoverInitResult: applyRecovery,
      buildReqCtx: () => ({}),
      buildInterceptResponse: () => null,
      recoveryMessages: [{ role: "user", content: "hello" }],
      allowStateMachine: false,
    } as never);

    expect(session.handleSessionInit).not.toHaveBeenCalled();
    expect(applyRecovery).toHaveBeenCalledOnce();
    expect(result.proceed).toBe(true);
    expect(result.initResult?.sessionInfo).toEqual(sessionInfo);
    expect(result.wentThroughStateMachine).toBe(false);
  });
});
