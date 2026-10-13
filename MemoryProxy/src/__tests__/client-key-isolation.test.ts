import { beforeEach, describe, expect, it, vi } from "vitest";

const writeToolCallMock = vi.hoisted(() => vi.fn());
vi.mock("../clickhouse.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../clickhouse.js")>()),
  writeToolCallRow: writeToolCallMock,
}));

import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
import { getSessionStore, __resetSessionStoreForTests } from "../session/store.js";
import { VersionPinRepo, type VersionPinRedisClient } from "../skill/version-pin-repo.js";
import {
  loadSessionIdsL1 as loadSkillSessionIdsL1,
  loadSessionIdsL2 as loadSkillSessionIdsL2,
  bindingToIdFields as skillBindingToIdFields,
} from "../skill/skill-bridge.js";
import {
  loadSessionIdsL1 as loadMemorySessionIdsL1,
  loadSessionIdsL2 as loadMemorySessionIdsL2,
  bindingToIdFields as memoryBindingToIdFields,
  toIdFields as memoryStateToIdFields,
} from "../memory/memory-bridge.js";
import type { SessionInfo, SessionInitState } from "../session/types.js";
import type { BindingRepo, SessionBinding } from "../db/binding-repo.js";

describe("Client key differentiation and session isolation", () => {
  beforeEach(() => {
    writeToolCallMock.mockClear();
    __resetSessionStoreForTests();
  });

  it("generates isolated Redis version pin keys for different clients with the same user and session", async () => {
    const memoryRedisData = new Map<string, Map<string, string>>();
    const mockRedis: VersionPinRedisClient = {
      hget: vi.fn(async (key: string, field: string) => {
        return memoryRedisData.get(key)?.get(field) ?? null;
      }),
      eval: vi.fn(async (_script: string, _numkeys: number, key: string, ...args: (string | number)[]) => {
        if (!memoryRedisData.has(key)) {
          memoryRedisData.set(key, new Map());
        }
        const hash = memoryRedisData.get(key)!;
        // args: ttl, k1, v1, k2, v2...
        for (let i = 1; i < args.length; i += 2) {
          const k = String(args[i]);
          const v = String(args[i + 1]);
          if (!hash.has(k)) {
            hash.set(k, v);
          }
        }
        return 1;
      }),
      multi: vi.fn(() => ({
        hset: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      })),
    };

    const pinRepo = new VersionPinRepo(mockRedis, 1800);
    const userId = "user-shared-42";
    const sessionId = "session-common-99";
    const skillId = "skill-deploy-tool";

    // Client 1 (codebuddy) pins version 1
    await pinRepo.pinMany(userId, "codebuddy", sessionId, [{ skillId, version: 1 }]);

    // Client 2 (claude-code) pins version 2
    await pinRepo.pinMany(userId, "claude-code", sessionId, [{ skillId, version: 2 }]);

    // Client 3 (workbuddy) pins version 3
    await pinRepo.pinMany(userId, "workbuddy", sessionId, [{ skillId, version: 3 }]);

    // Read back versions for each client
    const cbVersion = await pinRepo.getVersion(userId, "codebuddy", sessionId, skillId);
    const ccVersion = await pinRepo.getVersion(userId, "claude-code", sessionId, skillId);
    const wbVersion = await pinRepo.getVersion(userId, "workbuddy", sessionId, skillId);

    // Each client MUST have its own independent version pinned
    expect(cbVersion).toBe(1);
    expect(ccVersion).toBe(2);
    expect(wbVersion).toBe(3);

    // Verify distinct key generation in Redis
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "skill:vpin:user-shared-42:codebuddy:session-common-99",
      expect.anything(),
      skillId,
      "1",
    );
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "skill:vpin:user-shared-42:claude-code:session-common-99",
      expect.anything(),
      skillId,
      "2",
    );
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "skill:vpin:user-shared-42:workbuddy:session-common-99",
      expect.anything(),
      skillId,
      "3",
    );
  });

  it("production skill-bridge resolvers preserve client agent_source strictly without defaulting to claude-code", async () => {
    const store = getSessionStore();
    const commonSessionId = "shared-session-123";

    store.set(`codebuddy:${commonSessionId}`, {
      status: "initialized",
      keyId: `codebuddy:${commonSessionId}`,
      startedAt: Date.now(),
      attemptCount: 1,
      sessionInfo: {
        session_id: commonSessionId,
        user_id: "user-42",
        team_id: "team-1",
        agent_id: "agt-cb",
        space_id: "space-alpha",
        user_key: "sk-cb-key",
      },
    });

    store.set(`workbuddy:${commonSessionId}`, {
      status: "initialized",
      keyId: `workbuddy:${commonSessionId}`,
      startedAt: Date.now(),
      attemptCount: 1,
      sessionInfo: {
        session_id: commonSessionId,
        user_id: "user-42",
        team_id: "team-1",
        agent_id: "agt-wb",
        space_id: "space-alpha",
        user_key: "sk-wb-key",
      },
    });

    store.set(`claude-code:${commonSessionId}`, {
      status: "initialized",
      keyId: `claude-code:${commonSessionId}`,
      startedAt: Date.now(),
      attemptCount: 1,
      sessionInfo: {
        session_id: commonSessionId,
        user_id: "user-42",
        team_id: "team-1",
        agent_id: "agt-cc",
        space_id: "space-alpha",
        user_key: "sk-cc-key",
      },
    });

    // Real production loadSkillSessionIdsL1
    const cbFields = loadSkillSessionIdsL1(`codebuddy:${commonSessionId}`);
    const wbFields = loadSkillSessionIdsL1(`workbuddy:${commonSessionId}`);
    const ccFields = loadSkillSessionIdsL1(`claude-code:${commonSessionId}`);

    expect(cbFields).not.toBeNull();
    expect(cbFields?.agent_source).toBe("codebuddy");
    expect(cbFields?.agent_id).toBe("agt-cb");

    expect(wbFields).not.toBeNull();
    expect(wbFields?.agent_source).toBe("workbuddy");
    expect(wbFields?.agent_id).toBe("agt-wb");

    expect(ccFields).not.toBeNull();
    expect(ccFields?.agent_source).toBe("claude-code");
    expect(ccFields?.agent_id).toBe("agt-cc");

    // Real production skillBindingToIdFields & loadSkillSessionIdsL2
    const l2Binding: SessionBinding = {
      outcome: "initialized",
      userId: "user-42",
      teamId: "team-1",
      agentId: "agt-opencode",
      agentSource: "opencode",
      userKey: "sk-opencode",
    };

    const directL2Fields = skillBindingToIdFields(l2Binding, "space-alpha", commonSessionId);
    expect(directL2Fields?.agent_source).toBe("opencode");
    expect(directL2Fields?.composite_key).toBe(`opencode:${commonSessionId}`);

    const mockBindingRepo: BindingRepo = {
      getBinding: vi.fn(async () => l2Binding),
      putBinding: vi.fn().mockResolvedValue(undefined),
      deleteBinding: vi.fn().mockResolvedValue(undefined),
      touchLastSeen: vi.fn().mockResolvedValue(undefined),
    };

    const l2Fields = await loadSkillSessionIdsL2(mockBindingRepo, "space-alpha", commonSessionId);
    expect(l2Fields?.agent_source).toBe("opencode");
    expect(l2Fields?.composite_key).toBe(`opencode:${commonSessionId}`);
  });

  it("production memory-bridge resolvers strictly require session_id and reject incomplete state", async () => {
    // Real production memoryStateToIdFields: state missing session_id must return null
    const incompleteState: SessionInitState = {
      status: "initialized",
      keyId: "incomplete-key",
      startedAt: Date.now(),
      attemptCount: 1,
      sessionInfo: {
        user_id: "user-42",
        team_id: "team-1",
        agent_id: "agt-mem",
      } as SessionInfo,
    };

    const resultIncomplete = memoryStateToIdFields(incompleteState, "codebuddy:sess-mem-1");
    expect(resultIncomplete).toBeNull();

    // Valid state with session_id returns typed MemorySessionIdFields
    const validState: SessionInitState = {
      status: "initialized",
      keyId: "valid-key",
      startedAt: Date.now(),
      attemptCount: 1,
      sessionInfo: {
        user_id: "user-42",
        team_id: "team-1",
        agent_id: "agt-mem",
        session_id: "actual-session-id-123",
      },
    };

    const resultValid = memoryStateToIdFields(validState, "codebuddy:sess-mem-1");
    expect(resultValid).not.toBeNull();
    expect(resultValid?.session_id).toBe("actual-session-id-123");
    expect(resultValid?.agent_source).toBe("codebuddy");

    // Real production memoryBindingToIdFields & loadMemorySessionIdsL2
    const l2Binding: SessionBinding = {
      outcome: "initialized",
      userId: "user-42",
      teamId: "team-1",
      agentId: "agt-mem-l2",
      agentSource: "opencode",
      userKey: "sk-opencode-mem",
    };

    const directL2Fields = memoryBindingToIdFields(l2Binding, "space-alpha", "sess-mem-1");
    expect(directL2Fields?.session_id).toBe("sess-mem-1");
    expect(directL2Fields?.agent_source).toBe("opencode");

    const mockBindingRepo: BindingRepo = {
      getBinding: vi.fn(async () => l2Binding),
      putBinding: vi.fn().mockResolvedValue(undefined),
      deleteBinding: vi.fn().mockResolvedValue(undefined),
      touchLastSeen: vi.fn().mockResolvedValue(undefined),
    };

    const l2Fields = await loadMemorySessionIdsL2(mockBindingRepo, "space-alpha", "sess-mem-1");
    expect(l2Fields?.session_id).toBe("sess-mem-1");
    expect(l2Fields?.agent_source).toBe("opencode");
  });

  it("memory-bridge handler passes resolved agent_source to reject telemetry instead of falling back to unknown", async () => {
    const app = createApp(DEFAULT_CONFIG);
    const store = getSessionStore();
    const sessionId = "sess-mem-regress-400";

    // Store session under client-prefixed key in L1 cache
    store.set(`codebuddy:${sessionId}`, {
      status: "initialized",
      keyId: `codebuddy:${sessionId}`,
      startedAt: Date.now(),
      attemptCount: 1,
      sessionInfo: {
        user_id: "user-test-cb",
        team_id: "team-test",
        agent_id: "agt-test-cb",
        session_id: sessionId,
      },
    });

    // Client sends request with bare x-conversation-id (no client prefix in header)
    const response = await app.request("http://localhost/memory-bridge/v3/atomic/search", {
      method: "POST",
      headers: {
        "x-conversation-id": sessionId,
        "x-tdai-service-id": "space-test",
        "content-type": "application/json",
      },
      body: "{ malformed json",
    });

    expect(response.status).toBe(400);
    // Verifies that toIdFields populated agent_source from matchedKey so reject telemetry
    // captures "codebuddy" instead of falling back to "unknown" via agentSourceFromSessionKey(sessionKey)
    expect(writeToolCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "bridge_call",
        bridgeSource: "memory-bridge",
        sessionKey: sessionId,
        agentSource: "codebuddy",
        rejectReason: "invalid_json_body",
        upstreamStatus: 400,
      }),
    );

    // Verify uninitialized session records "unknown" as expected
    writeToolCallMock.mockClear();
    const uninitResponse = await app.request("http://localhost/memory-bridge/v3/atomic/search", {
      method: "POST",
      headers: {
        "x-conversation-id": "uninitialized-session-id",
        "x-tdai-service-id": "space-test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "test" }),
    });

    expect(uninitResponse.status).toBe(401);
    expect(writeToolCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "bridge_call",
        bridgeSource: "memory-bridge",
        sessionKey: "uninitialized-session-id",
        agentSource: "unknown",
        rejectReason: "session_not_initialized",
        upstreamStatus: 401,
      }),
    );
  });
});
