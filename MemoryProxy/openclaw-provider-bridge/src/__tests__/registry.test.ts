import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { wrapMemoryProxyStream } from "../bridge.js";
import { IdentityRegistry } from "../registry.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memory-proxy-bridge-"));
  const filePath = join(directory, "registry.json");
  return {
    filePath,
    registry: new IdentityRegistry({ filePath, scope: "test", configuredAgents: { main: { teamId: "team-1", memoryAgentId: "agent-1" } }, maxSessions: 100 }),
  };
}

describe("IdentityRegistry", () => {
  it("freezes identity per OpenClaw Agent + Session and persists it", async () => {
    const { filePath, registry } = await fixture();
    const first = await registry.getOrCreateSession("main", "session-a");
    await registry.setAgentIdentity("main", { teamId: "team-2", memoryAgentId: "agent-2" });
    expect(await registry.getOrCreateSession("main", "session-a")).toEqual(first);
    expect(await registry.getOrCreateSession("main", "session-b")).toMatchObject({ teamId: "team-2", memoryAgentId: "agent-2", conversationId: "session-b" });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 1, scope: "test" });
  });

  it("task selection is optional and rotates conversation when changed", async () => {
    const { registry } = await fixture();
    const original = await registry.getOrCreateSession("main", "session-a");
    const selected = await registry.setTaskId("main", "session-a", "task-1");
    expect(selected.taskId).toBe("task-1");
    expect(selected.conversationId).not.toBe(original.conversationId);
    expect((await registry.setTaskId("main", "session-a", undefined)).taskId).toBeUndefined();
  });
});

describe("wrapMemoryProxyStream", () => {
  it("attaches identity headers on every model call, including tool continuations", async () => {
    const { registry } = await fixture();
    const base = vi.fn(async () => ({ ok: true }));
    const wrapped = wrapMemoryProxyStream({ agentId: "main", streamFn: base } as any, registry)!;
    await wrapped({} as any, [] as any, { sessionId: "session-a", headers: {} } as any);
    await wrapped({} as any, [] as any, { sessionId: "session-a", headers: { "x-tool-loop": "1" } } as any);
    for (const call of base.mock.calls) {
      expect((call[2] as any).headers).toMatchObject({
        "x-team-id": "team-1", "x-agent-id": "agent-1",
        "x-conversation-id": "session-a", "x-openclaw-session-id": "session-a",
      });
      expect((call[2] as any).headers["x-task-id"]).toBeUndefined();
    }
  });
});
