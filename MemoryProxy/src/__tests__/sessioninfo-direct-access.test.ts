/**
 * Regression tests for the SessionInfo direct-access refactor.
 *
 * Twenty call sites across `handler.ts` / `anthropicHandler.ts` /
 * `codexHandler.ts` / `workbuddyHandler.ts` read identity fields off a
 * `SessionInfo` through a cast:
 *
 *     (initResult.sessionInfo as Record<string, unknown>)?.agent_id
 *     oldState.sessionInfo as Record<string, string>
 *
 * `SessionInfo` (src/session/types.ts) already declares every field those
 * sites read — `session_id`, `team_id`, `agent_id`, `user_id`, `space_id` — so
 * the casts bought nothing and cost two things:
 *
 *   1. TS2352 on all 20 sites ("Conversion of type 'SessionInfo' to type
 *      'Record<string, unknown>' may be a mistake").
 *   2. The property access became dynamic, so a typo like `.agnet_id`
 *      type-checked fine and failed at runtime.
 *
 * These tests pin the behaviour that must survive the cast removal:
 *   - reading the fields directly yields the same values;
 *   - optional fields (`space_id`, `task_id`) stay handled, including the
 *     `?? ""` default that `ForceArchiveInput.space_id` (required `string`)
 *     now needs — the cast used to hide that mismatch.
 */

import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../session/types.js";

const FULL: SessionInfo = {
  session_id: "sess-1",
  team_id: "team-aaaa-bbbb",
  agent_id: "agent-1111-2222",
  user_id: "user-3333",
  task_id: "task-4444",
  user_key: "uk-1",
  space_id: "mem-example001",
};

describe("SessionInfo identity fields are directly readable", () => {
  it("exposes the fields the handlers read, without a cast", () => {
    // These reads are the assertion: they only compile when the fields are
    // declared on the interface, which is what let the casts be dropped.
    const agentIdShort: string = String(FULL.agent_id);
    const teamId: string = FULL.team_id;
    const userId: string = FULL.user_id;
    const spaceId: string | undefined = FULL.space_id;

    expect(agentIdShort).toBe("agent-1111-2222");
    expect(teamId).toBe("team-aaaa-bbbb");
    expect(userId).toBe("user-3333");
    expect(spaceId).toBe("mem-example001");
  });

  it("keeps the truthiness guard working for optional fields", () => {
    // handler.ts / codexHandler.ts / workbuddyHandler.ts all gate the
    // force-archive fan-out on these four being present.
    const guard = (si: SessionInfo | null | undefined): boolean =>
      !!(si && si.space_id && si.user_id && si.team_id && si.agent_id);

    expect(guard(FULL)).toBe(true);
    expect(guard({ ...FULL, space_id: undefined })).toBe(false);
    expect(guard({ ...FULL, user_id: "" })).toBe(false);
    expect(guard(null)).toBe(false);
    expect(guard(undefined)).toBe(false);
  });

  it("defaults space_id for ForceArchiveInput, which requires a string", () => {
    // ForceArchiveInput.space_id is `string`; SessionInfo.space_id is optional.
    // The removed cast hid that, so the call sites now supply `?? ""`.
    const build = (si: SessionInfo) => ({
      space_id: si.space_id ?? "",
      user_id: si.user_id,
      team_id: si.team_id,
      agent_id: si.agent_id,
    });

    expect(build(FULL).space_id).toBe("mem-example001");
    expect(build({ ...FULL, space_id: undefined }).space_id).toBe("");
  });

  it("keeps task_id optional at the force-archive boundary", () => {
    const build = (si: SessionInfo) => si.task_id || undefined;

    expect(build(FULL)).toBe("task-4444");
    expect(build({ ...FULL, task_id: undefined })).toBeUndefined();
    expect(build({ ...FULL, task_id: "" })).toBeUndefined();
  });

  it("survives JSON round-trips the way stored sessions do", () => {
    const revived = JSON.parse(JSON.stringify(FULL)) as SessionInfo;
    expect(revived.agent_id).toBe(FULL.agent_id);
    expect(revived.team_id).toBe(FULL.team_id);
    expect(revived.space_id).toBe(FULL.space_id);
  });
});
