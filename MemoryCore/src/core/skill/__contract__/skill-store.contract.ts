/**
 * Shared ISkillStore contract suite.
 *
 * Backend-agnostic behavioral tests every ISkillStore must satisfy
 * (SqliteSkillStore, TcvdbSkillStore, MongoSkillStore). A concrete spec supplies
 * a harness that creates/disposes an isolated store for one backend.
 *
 * Scope (Phase-1 skill version-row surface):
 *   - lifecycle + capability shape
 *   - appendVersion create → getHead (v1)
 *   - appendVersion again → v2 head, v1 demoted, countVersions / listVersions DESC
 *   - listSkills returns head-only
 *   - searchSkills (BM25) recall by keyword
 *   - archiveHead soft-delete semantics (getHead vs getHeadIncludingArchived)
 *   - deleteAllVersions physical removal
 *
 * Skill `$search` (mongot) is eventually consistent → search assertions poll
 * when the harness sets `ftsEventuallyConsistent: true`.
 */
import { describe, it, expect } from "vitest";
import type { ISkillStore, SkillSearchResult } from "../skill-store.interface.js";
import type { AppendVersionInput } from "../types.js";

export interface SkillStoreContractHarness {
  backend: string;
  createStore(): Promise<ISkillStore>;
  disposeStore(store: ISkillStore): Promise<void>;
  ftsEventuallyConsistent?: boolean;
}

let seq = 0;
function makeInput(over: Partial<AppendVersionInput> = {}): AppendVersionInput {
  seq += 1;
  return {
    skill_id: over.skill_id ?? `sk-${Date.now()}-${seq}`,
    team_id: "team-a",
    owner_agent_id: "agent-a",
    user_id: "user-a",
    task_id: "task-a",
    name: over.name ?? `skill-${seq}`,
    description: over.description ?? "A contract-suite skill",
    content: over.content ?? "# Skill\nDo the thing.",
    content_hash: over.content_hash ?? `hash-${seq}`,
    manifest: over.manifest ?? [],
    storage_dir: over.storage_dir ?? "",
    ...over,
  };
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  { timeoutMs = 15_000, intervalMs = 400 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

export function runSkillStoreContract(harness: SkillStoreContractHarness): void {
  const { backend, ftsEventuallyConsistent } = harness;

  const searchExpect = async (
    run: () => Promise<SkillSearchResult[]>,
    want: (rows: SkillSearchResult[]) => boolean,
  ): Promise<SkillSearchResult[]> => (ftsEventuallyConsistent ? pollUntil(run, want) : run());

  describe(`ISkillStore contract [${backend}]`, () => {
    it("init → non-degraded + capability shape", async () => {
      const store = await harness.createStore();
      try {
        expect(store.isDegraded()).toBe(false);
        const caps = store.getCapabilities();
        expect(typeof caps.vectorSearch).toBe("boolean");
        expect(typeof caps.ftsSearch).toBe("boolean");
        expect(typeof caps.nativeHybridSearch).toBe("boolean");
        expect(typeof caps.sparseVectors).toBe("boolean");
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("appendVersion create → getHead returns v1", async () => {
      const store = await harness.createStore();
      try {
        const input = makeInput({ skill_id: "sk-create", name: "create-me" });
        const created = await store.appendVersion(input);
        expect(created.skill_id).toBe("sk-create");
        expect(created.version).toBe(1);
        expect(created.is_head).toBe(true);

        const head = await store.getHead("sk-create", "team-a");
        expect(head).not.toBeNull();
        expect(head!.version).toBe(1);
        expect(head!.name).toBe("create-me");
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("second appendVersion → v2 head, v1 demoted, versions listed DESC", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({ skill_id: "sk-ver", name: "versioned", content: "v1" }));
        const v2 = await store.appendVersion(makeInput({ skill_id: "sk-ver", name: "versioned", content: "v2" }));
        expect(v2.version).toBe(2);
        expect(v2.is_head).toBe(true);

        const head = await store.getHead("sk-ver", "team-a");
        expect(head!.version).toBe(2);

        const v1 = await store.getByVersion("sk-ver", 1, "team-a");
        expect(v1).not.toBeNull();
        expect(v1!.is_head).toBe(false);

        expect(await store.countVersions("sk-ver", "team-a")).toBe(2);
        const versions = await store.listVersions("sk-ver", "team-a");
        expect(versions.map((v) => v.version)).toEqual([2, 1]);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("listSkills returns head-only", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({ skill_id: "sk-list", name: "list-a", content: "v1" }));
        await store.appendVersion(makeInput({ skill_id: "sk-list", name: "list-a", content: "v2" }));
        const { items } = await store.listSkills({ team_id: "team-a" });
        const rows = items.filter((s) => s.skill_id === "sk-list");
        expect(rows).toHaveLength(1);
        expect(rows[0].version).toBe(2);
        expect(rows[0].is_head).toBe(true);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("searchSkills (BM25) recalls by keyword", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({
          skill_id: "sk-search-kube",
          name: "kubernetes-deploy",
          description: "Deploy services to a kubernetes cluster",
        }));
        await store.appendVersion(makeInput({
          skill_id: "sk-search-tea",
          name: "brew-tea",
          description: "Steep a nice cup of tea",
        }));

        const hits = await searchExpect(
          () => Promise.resolve(store.searchSkills({ team_id: "team-a", query: "kubernetes", mode: "bm25", topK: 10 })),
          (rows) => rows.some((r) => r.skill.skill_id === "sk-search-kube"),
        );
        expect(hits.some((r) => r.skill.skill_id === "sk-search-kube")).toBe(true);
        expect(hits.every((r) => typeof r.score === "number")).toBe(true);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("archiveHead soft-deletes (getHead null, getHeadIncludingArchived visible)", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({ skill_id: "sk-arch", name: "archive-me" }));
        const res = await store.archiveHead("sk-arch", "team-a");
        expect(res.archived).toBe(true);

        expect(await store.getHead("sk-arch", "team-a")).toBeNull();
        const arch = await store.getHeadIncludingArchived("sk-arch", "team-a");
        expect(arch).not.toBeNull();
        expect(arch!.status).toBe("archived");
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("deleteAllVersions physically removes every version row", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({ skill_id: "sk-del", name: "delete-me", content: "v1" }));
        await store.appendVersion(makeInput({ skill_id: "sk-del", name: "delete-me", content: "v2" }));

        const deleted = await store.deleteAllVersions("sk-del", "team-a");
        expect(deleted).toBe(2);
        expect(await store.getHeadIncludingArchived("sk-del", "team-a")).toBeNull();
        expect(await store.countVersions("sk-del", "team-a")).toBe(0);
      } finally {
        await harness.disposeStore(store);
      }
    });
  });
}
