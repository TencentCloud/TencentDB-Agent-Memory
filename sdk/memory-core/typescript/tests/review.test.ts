import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryClient } from "../src/v3/client.js";
import type { Transport } from "../src/client.js";

const config = { endpoint: "http://127.0.0.1:1", apiKey: "fixture", serviceId: "svc", teamId: "t1", agentId: "a1", userId: "u1" };

afterEach(() => vi.unstubAllGlobals());

describe("memory review SDK contract", () => {
  it("preserves operation identity and explicit scope without narrowing to a session", async () => {
    const post = vi.fn().mockResolvedValue({});
    const client = new MemoryClient({ post } as Transport, { team_id: "t1", user_id: "u1", agent_id: "a1", session_id: "unused" });
    await client.retractMemory({ record_id: "m", reason: "r", operation_id: "retry" });
    expect(post).toHaveBeenLastCalledWith("/v3/memory/review/retract", { record_id: "m", reason: "r", operation_id: "retry", team_id: "t1", user_id: "u1", agent_id: "a1" });
    await client.withIsolation({ taskId: "task" }).restoreMemory({ record_id: "m", operation_id: "restore" });
    expect(post.mock.lastCall?.[1]).toMatchObject({ task_id: "task", operation_id: "restore" });
    await client.listMemoryReviews({ visibility: "all" });
    expect(post.mock.lastCall?.[0]).toBe("/v3/memory/review/list");
    await client.reviewDerivedArtifact({ path: "persona.md" });
    expect(post.mock.lastCall?.[0]).toBe("/v3/memory/review/derived");
    expect(post.mock.lastCall?.[1]).not.toHaveProperty("session_id");
    await client.revertMemory({ record_id: "m", event_id: "evt", operation_id: "revert-retry" });
    expect(post.mock.lastCall?.[0]).toBe("/v3/memory/diff/revert");
    expect(post.mock.lastCall?.[1]).toMatchObject({ operation_id: "revert-retry", team_id: "t1", user_id: "u1", agent_id: "a1" });
    expect(post.mock.lastCall?.[1]).not.toHaveProperty("session_id");
  });

  it("uses only explicit operator attribution and rejects header injection", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await new MemoryClient({ ...config, reviewerId: "operator" }).restoreMemory({ record_id: "m" });
    expect(fetcher.mock.lastCall?.[1].headers).toHaveProperty("x-tdai-reviewer-id", "operator");
    await new MemoryClient(config).restoreMemory({ record_id: "m" });
    expect(fetcher.mock.lastCall?.[1].headers).not.toHaveProperty("x-tdai-reviewer-id");
    expect(() => new MemoryClient({ ...config, reviewerId: "bad\r\nheader" })).toThrow("safe header");
  });

  it("preserves partial commit information on a failed HTTP response", async () => {
    const data = { operation_id: "retry", commit_unknown: true, partial: { changed: ["a"] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 503, message: "retry", data }), { status: 503 })));
    await expect(new MemoryClient(config).retractMemory({ record_id: "m", reason: "r", operation_id: "retry" })).rejects.toMatchObject({ code: 503, details: data });
  });
});
