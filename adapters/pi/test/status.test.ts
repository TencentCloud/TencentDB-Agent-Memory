import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const verifyAuth = vi.fn();
const listTeams = vi.fn();
const listAgents = vi.fn();
const queryConversation = vi.fn();

// Point the lazy getAgentDir import at a scratch dir so the skill-pipeline
// scan never touches the real user's agent directory.
const agentDirHolder = vi.hoisted(() => ({ value: "" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => agentDirHolder.value }));

vi.mock("../src/clients.js", () => ({
  createClients: () => ({
    metadata: { verifyAuth, listTeams, listAgents },
    memory: { queryConversation },
  }),
}));

import { TDAMError } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { checkStatus, classifyError, maskId } from "../src/status.js";
import type { ConfigResult } from "../src/types.js";

function configured(): ConfigResult {
  return {
    ok: true,
    config: {
      enabled: true,
      endpoint: "http://127.0.0.1:8420",
      serviceId: "default",
      teamId: "team-123456789",
      agentId: "agt-123456789",
      userId: "usr-123456789",
      userKey: "secret-user-key",
      gatewayApiKey: "secret-gateway-key",
      timeoutMs: 1000,
      rejectUnauthorized: true,
      captureTools: false,
      recall: { enabled: true, deadlineMs: 3_000, l0Limit: 4, l1Limit: 6, l2Limit: 2, maxChars: 12000 },
      skills: { enabled: false, capture: true, runtimeTools: true, routingMode: "bm25", allowTeamSearch: false, includeFailedTools: false, maxMessageBytes: 32768, maxToolItems: 16, flushTimeoutMs: 1500 },
      sources: [],
      userKeySource: "key file",
      gatewayApiKeySource: "environment variable TDAI_MEMORY_GATEWAY_API_KEY",
    },
  };
}

describe("status", () => {
  it("reports ready only after auth, team, agent, and data-plane checks pass", async () => {
    verifyAuth.mockResolvedValue({
      valid: true,
      user: { user_id: "usr-123456789", username: "admin", user_type: "admin", created_at: "now" },
    });
    listTeams.mockResolvedValue({
      items: [{ team_id: "team-123456789", name: "Pi Team" }],
      total: 1,
      limit: 100,
      offset: 0,
    });
    listAgents.mockResolvedValue({
      items: [{ agent_id: "agt-123456789", name: "Pi Agent" }],
      total: 1,
      limit: 100,
      offset: 0,
    });
    queryConversation.mockResolvedValue({ items: [], total: 0 });

    const status = await checkStatus(configured());

    expect(status.kind).toBe("ready");
    expect(status.summary).toBe("memory: ready");
    expect(status.details.join("\n")).not.toContain("secret-user-key");
    expect(status.details.join("\n")).not.toContain("secret-gateway-key");
    expect(queryConversation).toHaveBeenCalledWith({ limit: 1, offset: 0 });
  });

  it("detects verified-user mismatch before querying tenant data", async () => {
    verifyAuth.mockResolvedValue({
      valid: true,
      user: { user_id: "usr-other", username: "other", user_type: "admin", created_at: "now" },
    });

    const status = await checkStatus(configured());

    expect(status.kind).toBe("auth-error");
    expect(status.summary).toBe("memory: identity mismatch");
  });

  it("returns configuration and disabled states without creating clients", async () => {
    await expect(checkStatus({ ok: false, errors: ["teamId is required"], sources: [] })).resolves.toEqual({
      kind: "config-error",
      summary: "memory: config error",
      details: ["teamId is required"],
    });
    await expect(checkStatus({ ok: true, config: { enabled: false, sources: [] } })).resolves.toEqual({
      kind: "disabled",
      summary: "memory: disabled",
      details: ["Adapter is disabled by configuration"],
    });
  });

  it("classifies SDK auth and network failures without exposing objects", () => {
    expect(classifyError(new TDAMError(401, "unauthorized")).kind).toBe("auth-error");
    expect(classifyError(new Error("fetch failed: ECONNREFUSED")).kind).toBe("offline");
  });

  it("masks long ids but leaves short ids readable", () => {
    expect(maskId("short")).toBe("short");
    expect(maskId("usr-123456789")).toBe("usr-12…6789");
  });

  it("reports a cold-start memory hint and the skill pipeline state when skills are on", async () => {
    verifyAuth.mockResolvedValue({
      valid: true,
      user: { user_id: "usr-123456789", username: "admin", user_type: "admin", created_at: "now" },
    });
    listTeams.mockResolvedValue({ items: [{ team_id: "team-123456789", name: "Pi Team" }], total: 1, limit: 100, offset: 0 });
    listAgents.mockResolvedValue({ items: [{ agent_id: "agt-123456789", name: "Pi Agent" }], total: 1, limit: 100, offset: 0 });
    queryConversation.mockResolvedValue({ items: [], total: 0 });

    const scratch = await mkdtemp(join(tmpdir(), "tdai-status-"));
    agentDirHolder.value = scratch;
    try {
      const skillsDir = join(scratch, "tdai-memory-skills");
      await mkdir(skillsDir, { recursive: true });
      await writeFile(join(skillsDir, "a.json"), JSON.stringify({ uncertain: true }), "utf8");
      await writeFile(join(skillsDir, "b.json.dead"), "{}", "utf8");

      const base = configured();
      if (!base.ok || !base.config.enabled) throw new Error("fixture must be enabled");
      const config = {
        ok: true as const,
        config: { ...base.config, skills: { ...base.config.skills, enabled: true } },
      };
      const status = await checkStatus(config);

      expect(status.kind).toBe("ready");
      const joined = status.details.join("\n");
      expect(joined).toContain("no conversations yet");
      expect(joined).toContain("Skills: on · pending 1 · uncertain 1 · dead 1");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
