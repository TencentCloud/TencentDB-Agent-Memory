/**
 * Create-side compensation for skill asset registration.
 *
 * `handleCreate` writes the skill row first and registers the `meta_assets` row
 * afterwards. Registration failure makes the whole request fail, so without a
 * compensating path the skill row survives a failed create: the caller sees an
 * error, the name stays taken for the next create, and `skill/list` keeps
 * showing the skill.
 *
 * These cases run `handleCreate` against a real SQLite-backed `SkillCore`.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { SkillCore } from "../core/skill/skill-core.js";
import { SkillResourceStore } from "../core/skill/skill-resource-store.js";
import { SkillVersioning } from "../core/skill/skill-versioning.js";
import { SqliteSkillStore } from "../core/store/sqlite/skill-store.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import type { IStorageBackend } from "../core/storage/types.js";
import type { Logger } from "../core/types.js";
import type { MetadataService } from "../metadata/service/metadata-service.js";
import { handleCreate, handleDelete, type SkillRouterDeps } from "./skill-handlers.js";
import type { V2AuthContext } from "./v2-schemas.js";

const AUTH: V2AuthContext = { apiKey: "test-api-key", serviceId: "test-svc" };
const REQUEST_ID = "req-test";

/** SKILL.md-shaped payload; frontmatter.name must equal `name`. */
function skillContent(name: string): string {
  return `---\nname: ${name}\ndescription: lifecycle test skill\n---\n\nbody of ${name}\n`;
}

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** In-memory object storage; only the paths the skill lifecycle touches are implemented. */
function memoryStorage(): StorageAdapter {
  const objects = new Map<string, Buffer>();
  const backend = {
    type: "local" as const,
    async putObject(key: string, content: string | Buffer) {
      objects.set(key, Buffer.from(content));
    },
    async getObject(key: string) {
      const content = objects.get(key);
      return content ? { key, content } : null;
    },
    async deleteObject(key: string) {
      objects.delete(key);
    },
    async deleteByPrefix(prefix: string) {
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) objects.delete(key);
      }
    },
    async exists(key: string) {
      return objects.has(key);
    },
    async listObjects() {
      return { objects: [] };
    },
  };
  return new StorageAdapter(backend as unknown as IStorageBackend);
}

function setup() {
  const db = new DatabaseSync(":memory:");
  const store = new SqliteSkillStore({ db, dimensions: 0 });
  store.init();
  const storage = memoryStorage();
  const resources = new SkillResourceStore({ storage });
  const versioning = new SkillVersioning({ store, resources, storage });
  const core = new SkillCore({ store, resources, versioning });
  return { db, core };
}

interface MetaStub {
  svc: MetadataService;
  ensured: string[];
  deleted: string[][];
}

function metaStub(failWith?: Error): MetaStub {
  const ensured: string[] = [];
  const deleted: string[][] = [];
  const svc = {
    async ensureSkillAsset(p: { skill_id: string }) {
      ensured.push(p.skill_id);
      if (failWith) throw failWith;
      return { asset_id: p.skill_id };
    },
    async deleteAssets(ids: string[]) {
      deleted.push(ids);
    },
  };
  return { svc: svc as unknown as MetadataService, ensured, deleted };
}

function deps(core: SkillCore, svc: MetadataService): SkillRouterDeps {
  return {
    getSkillCore: () => core,
    logger: silentLogger(),
    getMetadataService: async () => svc,
  };
}

function createBody(name: string, extra: Record<string, unknown> = {}) {
  return { name, content: skillContent(name), team_id: "team-a", agent_id: "agent-a", user_id: "user-a", ...extra };
}

function countSkillRows(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM skills").get() as { c: number };
  return row.c;
}

describe("/v3/skill/create asset registration", () => {
  it("registers the asset and keeps the skill row when registration succeeds", async () => {
    const { db, core } = setup();
    const meta = metaStub();

    const res = await handleCreate(createBody("keeper"), AUTH, REQUEST_ID, deps(core, meta.svc));

    expect(res.code).toBe(0);
    expect(meta.ensured).toHaveLength(1);
    expect(countSkillRows(db)).toBe(1);
  });

  it("removes the skill row when asset registration fails, so the name stays reusable", async () => {
    const { db, core } = setup();
    const meta = metaStub(new Error("cannot ensure skill asset: agent agent-a not found"));
    const routerDeps = deps(core, meta.svc);
    const coreDelete = vi.spyOn(core, "delete");

    const res = await handleCreate(createBody("recycled"), AUTH, REQUEST_ID, routerDeps);

    // The request still fails — the caller must not be told it succeeded.
    expect(res.code).not.toBe(0);

    // Nothing half-created is left behind: no skill row, and the asset row the
    // failed registration may have started writing is cleaned up too.
    expect(countSkillRows(db)).toBe(0);
    expect(coreDelete).toHaveBeenCalledTimes(1);
    expect(meta.ensured).toHaveLength(1);
    expect(coreDelete.mock.calls[0]![0].skill_id).toBe(meta.ensured[0]);
    expect(meta.deleted.flat()).toEqual([meta.ensured[0]]);

    // The reported symptom: retrying the same name must not hit
    // SKILL_NAME_DUPLICATE.
    const retry = await handleCreate(createBody("recycled"), AUTH, REQUEST_ID, deps(core, metaStub().svc));
    expect(retry.code).toBe(0);
    expect(countSkillRows(db)).toBe(1);
  });

  it("reuses the name after the skill is deleted", async () => {
    const { db, core } = setup();
    const meta = metaStub();
    const routerDeps = deps(core, meta.svc);

    const first = await handleCreate(createBody("reused"), AUTH, REQUEST_ID, routerDeps);
    expect(first.code).toBe(0);
    const skillId = (first.data as { skill_id: string }).skill_id;

    const removed = await handleDelete({ skill_id: skillId, team_id: "team-a" }, AUTH, REQUEST_ID, routerDeps);
    expect(removed.code).toBe(0);
    expect(countSkillRows(db)).toBe(0);

    const second = await handleCreate(createBody("reused"), AUTH, REQUEST_ID, routerDeps);
    expect(second.code).toBe(0);
    expect((second.data as { skill_id: string }).skill_id).not.toBe(skillId);
    expect(countSkillRows(db)).toBe(1);
  });

  it("reports the original registration error when the compensating delete also fails", async () => {
    const { core } = setup();
    const meta = metaStub(new Error("cannot ensure skill asset: agent agent-a not found"));
    vi.spyOn(core, "delete").mockRejectedValue(new Error("skill delete unavailable"));

    const res = await handleCreate(createBody("uncompensated"), AUTH, REQUEST_ID, deps(core, meta.svc));

    // The registration failure is what the caller needs to see; a broken
    // rollback must not replace it.
    expect(res.message).toContain("agent agent-a not found");
  });

  it("removes the skill row when the metadata service itself cannot be resolved", async () => {
    const { db, core } = setup();
    const routerDeps: SkillRouterDeps = {
      getSkillCore: () => core,
      logger: silentLogger(),
      getMetadataService: async () => {
        throw new Error("metadata service unavailable");
      },
    };

    const res = await handleCreate(createBody("no-meta"), AUTH, REQUEST_ID, routerDeps);

    expect(res.code).not.toBe(0);
    expect(countSkillRows(db)).toBe(0);
  });

  it("accumulates nothing across repeated create/delete cycles on one name", async () => {
    const { db, core } = setup();
    const failing = metaStub(new Error("cannot ensure skill asset: agent agent-a not found"));
    const routerDeps = deps(core, failing.svc);

    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await handleCreate(createBody("churn"), AUTH, REQUEST_ID, routerDeps);
      expect(res.code).not.toBe(0);
      expect(countSkillRows(db)).toBe(0);
    }

    // Each retry got its own skill_id — the reported symptom was a new active
    // row appearing on every attempt.
    expect(failing.ensured).toHaveLength(5);
    expect(new Set(failing.ensured).size).toBe(5);
    expect(failing.deleted).toHaveLength(5);

    const ok = await handleCreate(createBody("churn"), AUTH, REQUEST_ID, deps(core, metaStub().svc));
    expect(ok.code).toBe(0);
    expect(countSkillRows(db)).toBe(1);
  });
});