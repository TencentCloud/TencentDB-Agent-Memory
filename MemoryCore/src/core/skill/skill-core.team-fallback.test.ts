// Regression for #1577: the /v3/skill write endpoints accept an optional
// team_id, but SkillCore.appendNextVersion used to receive ctx.team_id as
// undefined — the store then fell back to team "default", appended into the
// wrong team, and tripped the (skill_id, version) UNIQUE constraint with a
// misleading version-conflict error.
//
// Contract after the fix: ctxOf() takes the located head and the version row's
// team resolves to head.team_id when the caller omitted team_id.
import { describe, expect, it } from "vitest";
import { SkillCore } from "./skill-core.js";
import type { ISkillStore, SkillResourceStore, SkillVersioning } from "./skill-store.interface.js";
import type { Skill } from "../types.js";

const HEAD: Skill = {
  skill_id: "skl-x",
  team_id: "team-real",
  name: "my-skill",
  version: 3,
  is_head: true,
  status: "active",
  owner_agent_id: "agent-1",
  content: "---\nname: my-skill\n---\nbody",
  created_at_ms: 1,
  updated_at_ms: 1,
} as unknown as Skill;

function makeCore(captured: { teamId?: string }) {
  const store = {
    getHead: async () => HEAD,
    listAclByAsset: async () => ({ items: [], total: 0, offset: 0, limit: 1 }),
  } as unknown as ISkillStore;
  const resources = {} as SkillResourceStore;
  const versioning = {
    appendNextVersion: async (head: Skill, ctx: { team_id?: string }) => {
      captured.teamId = ctx.team_id;
      return { ...head, version: head.version + 1 };
    },
    cleanupExpiredVersionsForSkill: async () => undefined,
  } as unknown as SkillVersioning;
  return new SkillCore({
    store,
    resources,
    versioning,
  } as never);
}

const CONTENT = "---\nname: my-skill\ndescription: d\n---\n\nbody\n";

describe("SkillCore write paths: version row lands in the head's team (#1577)", () => {
  it("update without team_id → ctx.team_id resolves to head.team_id", async () => {
    const captured: { teamId?: string } = {};
    const core = makeCore(captured);
    await core.update({ skill_id: "skl-x", content: CONTENT, expected_version: 3 } as never);
    expect(captured.teamId, "版本行必须落在 head 实际所在 team，而不是 default").toBe("team-real");
  });

  it("explicit team_id still wins when provided", async () => {
    const captured: { teamId?: string } = {};
    const core = makeCore(captured);
    await core.update({ skill_id: "skl-x", team_id: "team-real", content: CONTENT, expected_version: 3 } as never);
    expect(captured.teamId).toBe("team-real");
  });
});
