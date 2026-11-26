/**
 * `SkillCore.update({ replace_resources: true })` —— 同名替换（导入同名 skill 时
 * 前端"确认后替换"走的那条路）的语义回归。
 *
 * 覆盖的契约（PR 描述里逐条列出）：
 *   1. 替换后 skill_id 不变、version +1、manifest 恰等于上传集合（不是并集）；
 *   2. 被删掉的旧资源在新版本消失，但旧版本（get@v1 / files/read@v1）仍可回读；
 *   3. 不传 replace_resources 时行为与历史完全一致（只换 SKILL.md，资源原样带走）；
 *   4. content 与资源都没变 → 不升版（返回当前 head，版本号不增长）；
 *   5. 乐观锁仍然生效（expected_version 落后 → SKILL_VERSION_STALE）；
 *   6. 不能借替换改名（frontmatter.name ≠ head.name → INVALID_FRONTMATTER）；
 *   7. `resources: []` 表示清空全部资源；
 *   8. schema 层强制 replace_resources / resources 成对出现。
 *
 * 用真实实现跑（SqliteSkillStore + LocalStorageBackend），不 mock 存储层：
 * 版本号、manifest、storage 目录三者的一致性只有真跑才看得出来。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SkillCore, SkillCoreError, type CreateInput } from "./skill-core.js";
import { SkillResourceStore, type SkillResourcePayload } from "./skill-resource-store.js";
import { SkillVersioning } from "./skill-versioning.js";
import { SqliteSkillStore } from "../store/sqlite/skill-store.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import { StorageAdapter } from "../storage/adapter.js";
import { updateRequestSchema } from "../../gateway/skill-schemas.js";

const TEAM = "team-1";
const AGENT = "agt-1";
const USER = "u-1";
const NAME = "code-review";

function skillMd(name = NAME, body = "# Code Review\n\n原文"): string {
  return `---\nname: ${name}\ndescription: review helper\n---\n\n${body}`;
}

function file(path: string, content: string): SkillResourcePayload {
  return { path, content, encoding: "utf-8" };
}

describe("SkillCore.update — replace_resources", () => {
  let db: DatabaseSync;
  let dir: string;
  let core: SkillCore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const store = new SqliteSkillStore({ db, dimensions: 0 });
    store.init();

    dir = mkdtempSync(join(tmpdir(), "skill-replace-"));
    const storage = new StorageAdapter(new LocalStorageBackend({ rootDir: dir }));
    const resources = new SkillResourceStore({ storage });
    const versioning = new SkillVersioning({ store, resources, storage });
    // skill_id 注入固定值：单条用例里只 create 一次，碰撞检测不会触发。
    core = new SkillCore({ store, resources, versioning, ulid: () => "skl-test000001" });
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  function createInput(extra: Partial<CreateInput> = {}): CreateInput {
    return {
      user_id: USER,
      team_id: TEAM,
      agent_id: AGENT,
      name: NAME,
      content: skillMd(),
      resources: [file("docs/a.md", "A"), file("docs/b.md", "B")],
      ...extra,
    };
  }

  it("替换后 skill_id 不变、version+1、manifest 恰等于上传集合", async () => {
    const created = await core.create(createInput());

    const updated = await core.update({
      user_id: USER,
      team_id: TEAM,
      agent_id: AGENT,
      skill_id: created.skill_id,
      expected_version: 1,
      content: skillMd(NAME, "# Code Review\n\n新版正文"),
      replace_resources: true,
      resources: [file("docs/a.md", "A2"), file("docs/c.md", "C")],
    });

    expect(updated.skill_id).toBe(created.skill_id);
    expect(updated.version).toBe(2);
    expect(updated.content).toContain("新版正文");
    // 并集/差集只要算错，这里就会多出 docs/b.md
    expect(updated.manifest.map((m) => m.path).sort()).toEqual(["docs/a.md", "docs/c.md"]);
    expect(updated.manifest.find((m) => m.path === "docs/a.md")?.size_bytes).toBe(
      Buffer.byteLength("A2"),
    );

    // 新版本的资源内容确实是新的
    const readA = await core.readFile({
      skill_id: updated.skill_id, team_id: TEAM, path: "docs/a.md",
    });
    expect(readA.content).toBe("A2");
  });

  it("旧版本仍可回读：被删的 path 只在新版本消失", async () => {
    const created = await core.create(createInput());
    await core.update({
      user_id: USER,
      team_id: TEAM,
      agent_id: AGENT,
      skill_id: created.skill_id,
      expected_version: 1,
      content: skillMd(),
      replace_resources: true,
      resources: [file("docs/a.md", "A2")],
    });

    const v1 = await core.get({ skill_id: created.skill_id, team_id: TEAM, version: 1 });
    expect(v1.manifest.map((m) => m.path).sort()).toEqual(["docs/a.md", "docs/b.md"]);

    const bAtV1 = await core.readFile({
      skill_id: created.skill_id, team_id: TEAM, version: 1, path: "docs/b.md",
    });
    expect(bAtV1.content).toBe("B");

    // head（v2）里已经没有 b.md
    await expect(
      core.readFile({ skill_id: created.skill_id, team_id: TEAM, path: "docs/b.md" }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("不传 replace_resources 时行为不变：只换 SKILL.md，资源原样带走", async () => {
    const created = await core.create(createInput());

    const updated = await core.update({
      user_id: USER,
      team_id: TEAM,
      agent_id: AGENT,
      skill_id: created.skill_id,
      expected_version: 1,
      content: skillMd(NAME, "# Code Review\n\n只改正文"),
    });

    expect(updated.version).toBe(2);
    expect(updated.manifest.map((m) => m.path).sort()).toEqual(["docs/a.md", "docs/b.md"]);
    const a = await core.readFile({
      skill_id: created.skill_id, team_id: TEAM, path: "docs/a.md",
    });
    expect(a.content).toBe("A");
  });

  it("内容与资源全同 → 不升版", async () => {
    const created = await core.create(createInput());

    const same = await core.update({
      user_id: USER,
      team_id: TEAM,
      agent_id: AGENT,
      skill_id: created.skill_id,
      expected_version: 1,
      content: skillMd(),
      replace_resources: true,
      resources: [file("docs/b.md", "B"), file("docs/a.md", "A")],  // 顺序不同不算变化
    });

    expect(same.version).toBe(1);
    expect(same.content_hash).toBe(created.content_hash);
    const versions = await core.listVersions({ skill_id: created.skill_id, team_id: TEAM });
    expect(versions.total).toBe(1);
  });

  it("resources: [] → 清空全部资源", async () => {
    const created = await core.create(createInput());

    const cleared = await core.update({
      user_id: USER,
      team_id: TEAM,
      agent_id: AGENT,
      skill_id: created.skill_id,
      expected_version: 1,
      content: skillMd(),
      replace_resources: true,
      resources: [],
    });

    expect(cleared.version).toBe(2);
    expect(cleared.manifest).toEqual([]);
  });

  it("expected_version 落后 → SKILL_VERSION_STALE", async () => {
    const created = await core.create(createInput());

    await expect(
      core.update({
        user_id: USER,
        team_id: TEAM,
        agent_id: AGENT,
        skill_id: created.skill_id,
        expected_version: 7,
        content: skillMd(),
        replace_resources: true,
        resources: [],
      }),
    ).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
  });

  it("不能借替换改名", async () => {
    const created = await core.create(createInput());

    let caught: unknown;
    try {
      await core.update({
        user_id: USER,
        team_id: TEAM,
        agent_id: AGENT,
        skill_id: created.skill_id,
        expected_version: 1,
        content: skillMd("another-name"),
        replace_resources: true,
        resources: [],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SkillCoreError);
    expect((caught as SkillCoreError).code).toBe("INVALID_FRONTMATTER");
  });
});

describe("updateRequestSchema — replace_resources 配对校验", () => {
  const base = {
    user_id: USER,
    team_id: TEAM,
    agent_id: AGENT,
    skill_id: "skl-1",
    expected_version: 1,
    content: skillMd(),
  };

  it("两者都不传 → 通过（历史行为）", () => {
    expect(updateRequestSchema.safeParse(base).success).toBe(true);
  });

  it("replace_resources=true + resources=[] → 通过", () => {
    expect(
      updateRequestSchema.safeParse({ ...base, replace_resources: true, resources: [] }).success,
    ).toBe(true);
  });

  it("replace_resources=true 缺 resources → 拒绝（避免漏字段静默清空）", () => {
    const r = updateRequestSchema.safeParse({ ...base, replace_resources: true });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["resources"]);
  });

  it("只传 resources 不传 replace_resources → 拒绝（增量写走 files/write）", () => {
    const r = updateRequestSchema.safeParse({ ...base, resources: [file("a.md", "A")] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["resources"]);
  });
});
