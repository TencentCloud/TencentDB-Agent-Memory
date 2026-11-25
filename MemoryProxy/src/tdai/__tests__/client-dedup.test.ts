import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { TdaiClient } from "../client.js";
import type { TdaiIdentity, TdaiMemoryConfig, TdaiMessage } from "../types.js";

/**
 * Regression guard for PR #1623 review feedback (2026-10-15, @yangjj-iso):
 *
 * P2-1 — the dedup watermark key only covered (agentId, sessionId, taskId,
 * content). `l0UserDedupSeen` is a process-wide Map shared by *every*
 * TdaiClient — including clients pointed at different TDAI instances /
 * spaceIds and different team/user tenants. Two clients writing the same
 * content under the same local coordinates collided: the second instance's
 * user message was judged "already written" and silently dropped, so it never
 * reached that store at all.
 *
 * P2-2 — the 4096-entry cap was not enforced. When every entry was still
 * inside the 10-minute TTL, the cleanup pass deleted nothing, so the Map kept
 * growing past the cap and every new key re-scanned the whole Map on the way
 * in.
 *
 * The fix keys the watermark by the full storage identity (endpoint /
 * serviceId / teamId / userId / agentId / sessionId / taskId + content hash)
 * and evicts the oldest entries once the cap is reached.
 *
 * These tests drive the real `TdaiClient.addConversation()` against a loopback
 * HTTP fixture (same shape @yangjj-iso used to reproduce) and assert on the
 * requests that actually leave the process — a filtered-out user message means
 * no request at all, so request presence is the honest observable.
 */

interface CapturedRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: { messages?: TdaiMessage[]; session_id?: string; task_id?: string } & Record<string, unknown>;
}

interface Fixture {
  server: Server;
  url: string;
  captured: CapturedRequest[];
}

/** Minimal TDAI gateway stand-in: records every request, answers `code: 0`. */
function startFixture(): Promise<Fixture> {
  const captured: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      captured.push({
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : {},
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: {} }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, captured });
    });
  });
}

function stopFixture(fixture: Fixture): void {
  fixture.server.closeAllConnections();
  fixture.server.close();
}

function makeClient(endpoint: string, serviceId: string): TdaiClient {
  const config: TdaiMemoryConfig = {
    enabled: true,
    endpoint,
    apiKey: "test-key",
    serviceId,
    writeL0: true,
    recallL1: false,
    injectL2L3: false,
    l1Limit: 0,
    l2Limit: 0,
    timeoutMs: 10_000,
  };
  return new TdaiClient(config);
}

function makeIdentity(overrides: Partial<TdaiIdentity> = {}): TdaiIdentity {
  return {
    teamId: "team-regression",
    userId: "user-regression",
    agentId: "agent-regression",
    sessionId: "session-regression",
    taskId: "task-regression",
    ...overrides,
  };
}

const userMessage = (content: string): TdaiMessage[] => [{ role: "user", content }];

describe("L0 user-message dedup watermark", () => {
  it("still dedups the same identity + same content within the TTL", async () => {
    const fixture = await startFixture();
    try {
      const client = makeClient(fixture.url, "space-a");
      const identity = makeIdentity({ sessionId: "sess-basic", taskId: "task-basic" });
      const messages: TdaiMessage[] = [
        { role: "user", content: "同一个问题，重复携带" },
        { role: "assistant", content: "同一个回答" },
      ];

      await client.addConversation(identity, messages);
      await client.addConversation(identity, messages);

      // Round 1 writes user + assistant; round 2 drops the duplicate user and
      // still ships the assistant so the final answer is never lost.
      expect(fixture.captured).toHaveLength(2);
      expect(fixture.captured[0].body.messages?.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(fixture.captured[1].body.messages?.map((m) => m.role)).toEqual(["assistant"]);
    } finally {
      stopFixture(fixture);
    }
  });

  it("keeps two instances with different serviceId apart", async () => {
    const fixture = await startFixture();
    try {
      const clientA = makeClient(fixture.url, "instance-a");
      const clientB = makeClient(fixture.url, "instance-b");
      const identity = makeIdentity({ sessionId: "sess-cross-instance", taskId: "task-cross" });
      const messages = userMessage("同一个问题，发给两个实例");

      await clientA.addConversation(identity, messages);
      await clientB.addConversation(identity, messages);

      // Before the fix the second client's user message was filtered out and
      // no request left the process at all.
      expect(fixture.captured).toHaveLength(2);
      expect(fixture.captured[0].headers["x-tdai-service-id"]).toBe("instance-a");
      expect(fixture.captured[1].headers["x-tdai-service-id"]).toBe("instance-b");
      expect(fixture.captured[1].body.messages).toHaveLength(1);
      expect(fixture.captured[1].body.messages?.[0].role).toBe("user");
    } finally {
      stopFixture(fixture);
    }
  });

  it("keeps two clients pointed at different endpoints apart", async () => {
    const fixtureA = await startFixture();
    const fixtureB = await startFixture();
    try {
      const clientA = makeClient(fixtureA.url, "space-shared");
      const clientB = makeClient(fixtureB.url, "space-shared");
      const identity = makeIdentity({ sessionId: "sess-cross-endpoint", taskId: "task-cross" });
      const messages = userMessage("同一个问题，发给两个端点");

      await clientA.addConversation(identity, messages);
      await clientB.addConversation(identity, messages);

      expect(fixtureA.captured).toHaveLength(1);
      expect(fixtureB.captured).toHaveLength(1);
      expect(fixtureB.captured[0].body.messages).toHaveLength(1);
    } finally {
      stopFixture(fixtureA);
      stopFixture(fixtureB);
    }
  });

  it("keeps different team/user tenants apart", async () => {
    const fixture = await startFixture();
    try {
      const client = makeClient(fixture.url, "space-a");
      const base = { agentId: "agent-tenant", sessionId: "sess-tenant", taskId: "task-tenant" };

      await client.addConversation(
        makeIdentity({ ...base, teamId: "team-1", userId: "user-1" }),
        userMessage("跨租户的相同内容"),
      );
      await client.addConversation(
        makeIdentity({ ...base, teamId: "team-1", userId: "user-2" }),
        userMessage("跨租户的相同内容"),
      );
      await client.addConversation(
        makeIdentity({ ...base, teamId: "team-2", userId: "user-1" }),
        userMessage("跨租户的相同内容"),
      );

      expect(fixture.captured).toHaveLength(3);
      expect(fixture.captured[1].headers["x-tdai-user-id"]).toBe("user-2");
      expect(fixture.captured[2].headers["x-tdai-team-id"]).toBe("team-2");
    } finally {
      stopFixture(fixture);
    }
  });

  it(
    "enforces the 4096-entry cap by evicting the oldest entry (all entries still fresh)",
    async () => {
      const fixture = await startFixture();
      try {
        const client = makeClient(fixture.url, "space-capacity");
        const identity = makeIdentity({ sessionId: "sess-cap", taskId: "task-cap" });
        const TOTAL = 4097;

        for (let i = 0; i < TOTAL; i++) {
          await client.addConversation(identity, userMessage(`capacity probe ${i}`));
        }
        // Every content is unique, so every write goes out — before the fix
        // the Map grew past the cap without dropping anything.
        expect(fixture.captured).toHaveLength(TOTAL);

        // The oldest entry (probe 0) must have been evicted: replaying it
        // writes again.
        await client.addConversation(identity, userMessage("capacity probe 0"));
        expect(fixture.captured).toHaveLength(TOTAL + 1);

        // The newest entry (probe 4096) is still inside the window: replaying
        // it is deduped and produces no request.
        await client.addConversation(identity, userMessage(`capacity probe ${TOTAL - 1}`));
        expect(fixture.captured).toHaveLength(TOTAL + 1);
      } finally {
        stopFixture(fixture);
      }
    },
    120_000,
  );
});
