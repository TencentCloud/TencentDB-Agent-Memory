/**
 * SkillCore.create(replace) —— 同名 skill 上传替换已有 skill。
 *
 * 用真实 SqliteSkillStore（node:sqlite 内存库）+ LocalStorageBackend（临时目录），
 * 覆盖版本递增、资源整体替换、旧版本保留为历史、replace=false 仍报重名、
 * 只替换同 team + 同 owner agent 的同名 skill。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalStorageBackend } from "../storage/local-backend.js";
import { StorageAdapter } from "../storage/adapter.js";
import { SqliteSkillStore } from "../store/sqlite/skill-store.js";
import { SkillCore, SkillCoreError } from "./skill-core.js";
import { SkillResourceStore } from "./skill-resource-store.js";
import { SkillVersioning } from "./skill-versioning.js";

const NAME = "cc-auto-test-run-case-finalization";

function skillMd(body: string, name = NAME, description = "finalize test cases"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

const ids = (agent = "agt-a", team = "team-1") => ({
  team_id: team,
  agent_id: agent,
  user_id: "u-1",
});

describe("SkillCore.create replace=true", () => {
  let dir: string;
  let db: DatabaseSync;
  let core: SkillCore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-replace-"));
    db = new DatabaseSync(":memory:");
    const store = new SqliteSkillStore({ db, dimensions: 0 });
    store.init();
    const storage = new StorageAdapter(new LocalStorageBackend(dir));
    const resources = new SkillResourceStore({ storage });
    const versioning = new SkillVersioning({ store, resources, storage });
    core = new SkillCore({ store, resources, versioning });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("replace 未传 / false 时同名仍返回 SKILL_NAME_DUPLICATE", async () => {
    await core.create({ ...ids(), name: NAME, content: skillMd("v1") });
    for (const replace of [undefined, false]) {
      const err = await core
        .create({ ...ids(), name: NAME, content: skillMd("v2"), replace })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SkillCoreError);
      expect((err as SkillCoreError).code).toBe("SKILL_NAME_DUPLICATE");
    }
  });

  it("命中同名：同 skill_id 版本 old+1，SKILL.md 与资源整体替换，旧版本保留为历史", async () => {
    const v1 = await core.create({
      ...ids(),
      name: NAME,
      content: skillMd("v1 body"),
      resources: [
        { path: "a.md", content: "old-a", encoding: "utf-8" },
        { path: "scripts/run.sh", content: "echo old", encoding: "utf-8" },
      ],
    });
    expect(v1.version).toBe(1);

    const out = await core.createWithOutcome({
      ...ids(),
      name: NAME,
      content: skillMd("v2 body", NAME, "updated description"),
      resources: [
        { path: "scripts/run.sh", content: "echo new", encoding: "utf-8" },
        { path: "c.txt", content: "new-c", encoding: "utf-8" },
      ],
      replace: true,
    });

    expect(out.replaced).toBe(true);
    expect(out.previous_version).toBe(1);
    expect(out.skill.skill_id).toBe(v1.skill_id);
    expect(out.skill.version).toBe(2);
    expect(out.skill.description).toBe("updated description");
    expect(out.skill.manifest.map((m) => m.path).sort()).toEqual(["c.txt", "scripts/run.sh"]);

    const head = await core.get({ skill_id: v1.skill_id, team_id: "team-1" });
    expect(head.version).toBe(2);
    expect(head.content).toContain("v2 body");

    const run = await core.readFile({ skill_id: v1.skill_id, team_id: "team-1", path: "scripts/run.sh" });
    expect(run.content).toBe("echo new");
    await expect(
      core.readFile({ skill_id: v1.skill_id, team_id: "team-1", path: "a.md" }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });

    // 旧 head 降为历史版本，仍可按 version 回看
    const old = await core.get({ skill_id: v1.skill_id, team_id: "team-1", version: 1 });
    expect(old.is_head).toBe(false);
    expect(old.content).toContain("v1 body");
    const oldA = await core.readFile({ skill_id: v1.skill_id, team_id: "team-1", version: 1, path: "a.md" });
    expect(oldA.content).toBe("old-a");

    const versions = await core.listVersions({ skill_id: v1.skill_id, team_id: "team-1" });
    expect(versions.total).toBe(2);

    // 列表里只有一个 head，不会出现两个同名 skill
    const list = await core.list({ ...ids(), filters: { name_prefix: NAME } });
    expect(list.items.map((s) => [s.skill_id, s.version])).toEqual([[v1.skill_id, 2]]);

    // 再替换一次 → v3
    const again = await core.createWithOutcome({ ...ids(), name: NAME, content: skillMd("v3 body"), replace: true });
    expect(again.skill.version).toBe(3);
    expect(again.previous_version).toBe(2);
    expect(again.skill.manifest).toEqual([]); // 本次未带资源 → 资源被整体清空
  });

  it("replace=true 但不存在同名 skill 时按普通 create 新建 v1", async () => {
    const out = await core.createWithOutcome({ ...ids(), name: NAME, content: skillMd("fresh"), replace: true });
    expect(out.replaced).toBe(false);
    expect(out.previous_version).toBeUndefined();
    expect(out.skill.version).toBe(1);
  });

  it("只替换同 team + 同 owner agent 的同名 skill；其它 agent / team 同名不受影响", async () => {
    const a = await core.create({ ...ids("agt-a"), name: NAME, content: skillMd("A v1") });
    const otherTeam = await core.create({ ...ids("agt-a", "team-2"), name: NAME, content: skillMd("T2 v1") });

    // agent B 首次 replace：A 的同名 skill 不是它的，按新建处理
    const b = await core.createWithOutcome({ ...ids("agt-b"), name: NAME, content: skillMd("B v1"), replace: true });
    expect(b.replaced).toBe(false);
    expect(b.skill.skill_id).not.toBe(a.skill_id);
    expect(b.skill.version).toBe(1);
    expect(b.skill.owner_agent_id).toBe("agt-b");

    // agent A replace：只动自己 team-1 下的那个
    const a2 = await core.createWithOutcome({ ...ids("agt-a"), name: NAME, content: skillMd("A v2"), replace: true });
    expect(a2.skill.skill_id).toBe(a.skill_id);
    expect(a2.skill.version).toBe(2);

    const bHead = await core.get({ skill_id: b.skill.skill_id, team_id: "team-1" });
    expect(bHead.version).toBe(1);
    expect(bHead.content).toContain("B v1");
    const t2Head = await core.get({ skill_id: otherTeam.skill_id, team_id: "team-2" });
    expect(t2Head.version).toBe(1);
    expect(t2Head.content).toContain("T2 v1");
  });

  it("前缀同族名字不会被误替换（name_prefix 命中后精确比对）", async () => {
    const longer = await core.create({ ...ids(), name: `${NAME}-extra`, content: skillMd("x", `${NAME}-extra`) });
    const out = await core.createWithOutcome({ ...ids(), name: NAME, content: skillMd("base"), replace: true });
    expect(out.replaced).toBe(false);
    expect(out.skill.skill_id).not.toBe(longer.skill_id);
    const head = await core.get({ skill_id: longer.skill_id, team_id: "team-1" });
    expect(head.version).toBe(1);
  });

  it("同进程并发替换被串行化：版本依次递增，无冲突", async () => {
    const base = await core.create({ ...ids(), name: NAME, content: skillMd("base") });
    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        core.createWithOutcome({
          ...ids(),
          name: NAME,
          content: skillMd(`concurrent ${i}`),
          resources: [{ path: "r.txt", content: `r${i}`, encoding: "utf-8" }],
          replace: true,
        }),
      ),
    );
    expect(results.map((r) => r.skill.version).sort()).toEqual([2, 3, 4]);
    expect(results.every((r) => r.skill.skill_id === base.skill_id)).toBe(true);
    const head = await core.get({ skill_id: base.skill_id, team_id: "team-1" });
    expect(head.version).toBe(4);
    const r = await core.readFile({ skill_id: base.skill_id, team_id: "team-1", path: "r.txt" });
    expect(r.content).toBe(head.content.includes("concurrent 1") ? "r1" : head.content.includes("concurrent 2") ? "r2" : "r3");
  });

  it("内容与资源完全未变化时幂等：不产生新版本", async () => {
    const v1 = await core.create({ ...ids(), name: NAME, content: skillMd("same") });
    const out = await core.createWithOutcome({ ...ids(), name: NAME, content: skillMd("same"), replace: true });
    expect(out.replaced).toBe(true);
    expect(out.previous_version).toBe(1);
    expect(out.skill.version).toBe(1);
    expect(out.skill.skill_id).toBe(v1.skill_id);
  });

  it("frontmatter.name 与 name 不一致时仍拒绝（不会进入替换）", async () => {
    await core.create({ ...ids(), name: NAME, content: skillMd("v1") });
    await expect(
      core.create({ ...ids(), name: NAME, content: skillMd("v2", "other-name"), replace: true }),
    ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
  });
});
