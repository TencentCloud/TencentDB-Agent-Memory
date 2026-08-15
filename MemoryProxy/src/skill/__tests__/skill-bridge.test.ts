import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "hono";

import { buildConfig } from "../../config.js";
import { getSessionStore } from "../../session/store.js";
import { createSkillBridgeHandler } from "../skill-bridge.js";
import type { CoreSkillClient } from "../core-client.js";

// Regression test for issue #1006: skill_search used to subtract a
// real-time /v3/skill/listing call ("C") from the whitelist, but the
// listing is a live snapshot while <available_skills> is a session-init
// snapshot. A skill created after session init showed up in the live
// listing, got treated as "already injected", and was excluded from
// search forever -- even though it was never actually in the prompt.
// The fix drops that exclusion entirely: whitelist = A (team-shared) ∪ B
// (agent-owned), no C subtraction.

const SESSION_ID = "test-session-1006";
const TEAM_ID = "team-1";
const AGENT_ID = "agent-1";
const USER_ID = "user-1";
const SPACE_ID = "space-1";

function seedSession(): void {
  getSessionStore().set(`claude-code:${SESSION_ID}`, {
    status: "initialized",
    keyId: `claude-code:${SESSION_ID}`,
    startedAt: Date.now(),
    attemptCount: 0,
    sessionInfo: {
      session_id: SESSION_ID,
      team_id: TEAM_ID,
      agent_id: AGENT_ID,
      user_id: USER_ID,
      space_id: SPACE_ID,
      user_key: "test-user-key",
    },
  });
}

function searchRequest(query = "toy"): Context {
  const req = new Request("http://localhost/skill-bridge/v3/skill/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-conversation-id": SESSION_ID,
      "x-tdai-service-id": SPACE_ID,
    },
    body: JSON.stringify({ query }),
  });
  return new Context(req);
}

describe("skill-bridge team search whitelist", () => {
  beforeEach(() => {
    seedSession();
  });

  afterEach(() => {
    getSessionStore().delete(`claude-code:${SESSION_ID}`);
  });

  it("does not exclude a skill created after session init (issue #1006)", async () => {
    // A: no team-shared skills (isolate the bug to B, matching the report's
    // repro where the new skill is the agent's own, not a team asset).
    const resolveVisibleSkillIds = async () => ({ ids: [] });

    // B: the agent's full owned-skill listing -- includes a skill that was
    // created mid-session, after the <available_skills> snapshot was taken.
    const coreClient = {
      listSkills: async () => ({
        items: [{ skill_id: "new-skill-created-mid-session" }],
      }),
      // listListing (C) intentionally NOT called by the fixed code anymore --
      // if the fix regresses and starts calling it again, this mock would
      // throw and fail the test loudly rather than silently reporting the
      // old buggy result.
    } as unknown as CoreSkillClient;

    // Upstream plugin search response: returns the mid-session skill among
    // its hits (it's a real skill in the pool, findable by keyword/BM25).
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          code: 0,
          message: "ok",
          request_id: "test-req-1",
          data: {
            items: [
              { skill_id: "new-skill-created-mid-session", name: "toy skill" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const config = buildConfig({});
    const handler = createSkillBridgeHandler(config, {
      resolveVisibleSkillIds,
      coreClient,
      fetcher,
    });

    const res = await handler(searchRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.data.items as Array<{ skill_id: string }>).map(
      (item) => item.skill_id,
    );
    // The mid-session skill must survive the whitelist filter -- pre-fix,
    // it would have been silently dropped to an empty items list.
    expect(ids).toContain("new-skill-created-mid-session");
  });
});
