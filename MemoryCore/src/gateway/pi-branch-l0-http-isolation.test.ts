import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeFixture,
  post,
  startE2EGateway,
  stopE2EGateway,
  type Fixture,
} from "./chat-memory-e2e-helpers.js";

interface ConversationQueryData {
  messages: Array<{ content: string; session_id: string }>;
}

describe("Pi /tree branch L0 HTTP isolation", () => {
  beforeAll(async () => {
    await startE2EGateway("pi-branch-l0-http");
  });

  afterAll(async () => {
    await stopE2EGateway();
  });

  it("keeps Gateway L0 writes and reads isolated between sibling branches", async () => {
    const fixture = await makeFixture("pi-branch-l0-http", 0);
    const baseSessionId = `pi-${fixture.sessionId}`;
    const branchA = `${baseSessionId}-branch-a`;
    const branchB = `${baseSessionId}-branch-b`;

    await writeL0(fixture, branchA, "Pi branch A only evidence");
    await writeL0(fixture, branchB, "Pi branch B only evidence");

    const [fromA, fromB] = await Promise.all([
      readL0(fixture, branchA),
      readL0(fixture, branchB),
    ]);

    expect(fromA).toHaveLength(1);
    expect(fromA[0]).toMatchObject({
      content: "Pi branch A only evidence",
      session_id: branchA,
    });
    expect(fromB).toHaveLength(1);
    expect(fromB[0]).toMatchObject({
      content: "Pi branch B only evidence",
      session_id: branchB,
    });
  });
});

async function writeL0(fixture: Fixture, sessionId: string, content: string): Promise<void> {
  const result = await post(
    "/v3/conversation/add",
    {
      team_id: fixture.teamId,
      user_id: fixture.userId,
      agent_id: fixture.agentId,
      session_id: sessionId,
      // The isolation assertion only needs L0. Assistant-only avoids unrelated
      // asynchronous L1 extraction work in this integration test.
      messages: [{ role: "assistant", content }],
    },
    { userKey: fixture.userKey },
  );
  expect(result.body.code).toBe(0);
}

async function readL0(fixture: Fixture, sessionId: string): Promise<ConversationQueryData["messages"]> {
  const result = await post<ConversationQueryData>(
    "/v3/conversation/query",
    {
      team_id: fixture.teamId,
      user_id: fixture.userId,
      agent_id: fixture.agentId,
      session_id: sessionId,
      limit: 10,
    },
    { userKey: fixture.userKey },
  );
  expect(result.body.code).toBe(0);
  return result.body.data?.messages ?? [];
}
