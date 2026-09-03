import { describe, expect, it, vi } from "vitest";
import type { Transport } from "../src/client.js";
import { MemoryClient } from "../src/v3/client.js";

function makeClient() {
  const post = vi.fn().mockResolvedValue({
    id: "memory-1",
    version: "v4",
    updated_at: "2026-09-02T00:00:00.000Z",
  });
  const transport = { post } as unknown as Transport;
  const client = new MemoryClient(transport, {
    team_id: "team-1",
    agent_id: "agent-1",
    user_id: "user-1",
    session_id: "session-1",
  });
  return { client, post };
}

describe("v3 MemoryClient.updateAtomic expected_version", () => {
  it("forwards the compare-and-swap guard", async () => {
    const { client, post } = makeClient();

    const result = await client.updateAtomic({
      id: "memory-1",
      content: "edited content",
      expected_version: 3,
    });

    expect(post).toHaveBeenCalledWith("/v3/atomic/update", {
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
      session_id: "session-1",
      id: "memory-1",
      content: "edited content",
      expected_version: 3,
    });
    expect(result.version).toBe("v4");
  });

  it("omits the guard for backward-compatible last-write-wins calls", async () => {
    const { client, post } = makeClient();

    await client.updateAtomic({ id: "memory-1", content: "legacy edit" });

    expect(post.mock.calls[0][1]).not.toHaveProperty("expected_version");
  });
});
