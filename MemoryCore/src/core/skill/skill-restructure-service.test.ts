import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteSkillStore } from "../store/sqlite/skill-store.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import { StorageAdapter } from "../storage/adapter.js";
import { SkillCore } from "./skill-core.js";
import { SkillResourceStore } from "./skill-resource-store.js";
import { SkillVersioning } from "./skill-versioning.js";
import { SqliteSkillStateStore } from "./skill-state-store.js";
import { SkillRestructureService, type SkillRestructureServiceOptions } from "./skill-restructure-service.js";
import type { SkillCandidateSubmission, SkillRestructureConfig } from "./skill-restructure-types.js";
import type { RestructureRunner, ReviewedSkillRestructureResult, SkillPackageSnapshot, SkillRestructureOptions } from "./restructure/types.js";
import type { Skill } from "./types.js";
import { canonical, createSkillPackageSnapshot, hash } from "./restructure/snapshot.js";

const actor = { user_id: "user", team_id: "team", agent_id: "agent", task_id: "task" };
const doc = (name: string, body: string) => `---\nname: ${name}\ndescription: A reusable procedure\nsource: auto\n---\n\n${body}`;
const PRIOR_TLS = "Always verify TLS certificates; never disable verification.";
const PRIOR_APPROVAL = "Obtain approval before production changes.";
/** Executes actual engine tools; this scripted reviewer exposes preservation regressions, not model-quality proof. */
function preservationRunner() {
  const baselineBodies: string[] = [];
  const run = vi.fn(async (params: Parameters<RestructureRunner["run"]>[0]) => {
    const execute = async (name: string, args: unknown): Promise<any> => (params.tools![name] as { execute(args: unknown, context: unknown): Promise<unknown> }).execute(args, { toolCallId: "baseline-publication", messages: [] });
    const read = async (name: string) => {
      const index = await execute(name, { ids: [] }); const blocks: Array<{ id: string; path: string; content: string }> = [];
      for (const block of index.blocks) if (block.kind === "text") blocks.push(...(await execute(name, { ids: [block.id] })).blocks);
      return { index, blocks, body: blocks.filter(block => block.path === "SKILL.md").map(block => block.content).join("") };
    };
    const candidate = await read("read_source");
    const prior = params.tools!.read_baseline ? await read("read_baseline") : undefined;
    if (prior) baselineBodies.push(prior.body);
    const ids = candidate.blocks.filter(block => block.path === "SKILL.md").map(block => block.id);
    const target = { packageKey: "root", path: "SKILL.md", quote: PRIOR_APPROVAL };
    if (params.tools!.submit_draft) {
      await execute("submit_draft", { kind: "keep", rationale: "The proposed candidate is coherent; independent review must still compare the prior package.", children: [], transformations: [],
        dispositions: candidate.index.blocks.map((block: { id: string; path: string }) => ({ sourceId: block.id, action: "preserve", reason: "Preserve the proposed bytes.", targets: [{ packageKey: "root", path: block.path }] })),
        ruleMappings: [{ rule: PRIOR_APPROVAL, critical: true, sourceIds: ids, targets: [target] }] });
    } else {
      const draft = await read("read_draft"); const materialized = JSON.parse(draft.blocks.map(block => block.content).join(""));
      const body = materialized.packages.find((pkg: { key: string }) => pkg.key === "root").content as string;
      const missing = Boolean(prior?.body.includes(PRIOR_TLS) && !body.includes(PRIOR_TLS));
      const evidence: Array<{ sourceIds: string[]; target?: typeof target; explanation: string }> = [{ sourceIds: ids, target, explanation: "Candidate approval constraint is retained." }];
      if (prior) evidence.push({ sourceIds: prior.blocks.filter(block => block.path === "SKILL.md").map(block => block.id), ...(missing ? {} : { target: { ...target, quote: body.includes(PRIOR_TLS) ? PRIOR_TLS : PRIOR_APPROVAL } }), explanation: missing ? "The original package's buried TLS-verification rule was lost." : "Prior critical rules remain in the final candidate; resource changes are proposals, not mandatory old copies." });
      await execute("submit_review", { verdict: missing ? "fail" : "pass", draftHash: draft.index.draftHash, ...(prior ? { baselineFingerprint: prior.index.baselineFingerprint } : {}),
        summary: missing ? "Reject missing original TLS constraint." : "Prior and proposed packages were compared.", checks: { preservation: !missing, organization: true, independence: true, grounding: true, injectionSafety: true }, evidence });
    }
    return "explicit submission complete";
  });
  return { runner: { run }, run, baselineBodies };
}

function approved(snapshot: SkillPackageSnapshot, children = true, baseline?: SkillPackageSnapshot): ReviewedSkillRestructureResult {
  const source = createSkillPackageSnapshot(snapshot);
  const baselineFingerprint = baseline ? createSkillPackageSnapshot(baseline).sourceFingerprint : undefined;
  const content = doc(snapshot.name, "Obtain approval before production changes.\n" + (children ? "For independent UI reviews load {{skill:frontend-review}}.\n" : ""));
  const frozenDraftHash = hash(canonical({ content, children, sourceFingerprint: source.sourceFingerprint, baselineFingerprint }));
  return { kind: "restructured", sourceFingerprint: source.sourceFingerprint, ...(baselineFingerprint ? { baselineFingerprint } : {}), frozenDraftHash, rationale: "Distill repeated procedure and separate independent UI review.",
    root: { key: "root", name: snapshot.name, content, resources: snapshot.resources, resourcePlans: snapshot.resources.map(r => ({ kind: "copy_from", path: r.path, sourcePath: r.path })),
      children: children ? ["frontend-review"] : [], identity: snapshot.identity, metadata: snapshot.metadata },
    children: children ? [{ key: "frontend-review", name: "frontend-review", content: doc("frontend-review", "Review keyboard access and visible focus. Obtain approval before production changes."), resources: [], resourcePlans: [], children: [], identity: snapshot.identity, metadata: {} }] : [],
    review: { verdict: "pass", draftHash: frozenDraftHash, ...(baselineFingerprint ? { baselineFingerprint } : {}), summary: "Publication fixture: semantic review is injected as already completed.", checks: { preservation: true, organization: true, independence: true, grounding: true, injectionSafety: true }, evidence: [] },
    ruleMappings: [], dispositions: [], coverage: { writer: source.blocks.map(b => b.id), reviewer: source.blocks.map(b => b.id), draft: ["fixture-draft"] } };
}

describe("semantic operation lifecycle with real SQLite/local storage", () => {
  let dir: string, db: DatabaseSync, core: SkillCore, store: SqliteSkillStore, storage: StorageAdapter, state: SqliteSkillStateStore;
  let now: number;
  const engine = vi.fn(async (snapshot: SkillPackageSnapshot, options?: SkillRestructureOptions) => approved(snapshot, true, options?.baselineSnapshot));
  const ensureAsset = vi.fn(async (_skill: Skill) => {});
  const makeService = (overrides: Partial<SkillRestructureServiceOptions> = {}) => new SkillRestructureService({ core, storage, state, namespace: "instance", runner: { run: async () => "unused by injected semantic-engine fixture" },
    engine, ensureAsset, now: () => now, ...overrides, config: { retryDelayMs: 0, ...overrides.config } });
  beforeEach(async () => {
    now = Date.now(); engine.mockReset().mockImplementation(async (snapshot, options) => approved(snapshot, true, options?.baselineSnapshot)); ensureAsset.mockReset().mockResolvedValue(undefined);
    dir = await mkdtemp(join(tmpdir(), "semantic-operation-"));
    db = new DatabaseSync(":memory:"); store = new SqliteSkillStore({ db, dimensions: 0 }); store.init();
    storage = new StorageAdapter(new LocalStorageBackend(dir)); const resources = new SkillResourceStore({ storage });
    core = new SkillCore({ store, resources, versioning: new SkillVersioning({ store, resources, storage }) });
    state = new SqliteSkillStateStore(db); await state.init();
    await core.createPackageVersion({ ...actor, skill_id: "skl-source", mutation_id: "seed", name: "operations-guide",
      content: doc("operations-guide", "Obtain approval before production changes.\n".repeat(700)), resources: [{ path: "scripts/check.sql", content: "SELECT 1;", encoding: "utf-8" }], metadata: { user_note: "retain" } });
  });
  afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  async function candidate(request_id = "review-task"): Promise<SkillCandidateSubmission> {
    const source = await core.readPackage({ ...actor, skill_id: "skl-source", expected_version: 1 });
    return { ...actor, request_id, source: { skill_id: "skl-source", expected_version: 1 }, force: true,
      candidate: { name: source.skill.name, content: source.skill.content, resources: source.resources, metadata: JSON.parse(source.skill.metadata_json) } };
  }

  async function simulateLegacyInputWithoutBaseline(operationId: string) {
    const prefix = `skill-restructure/${hash("instance")}`;
    const key = `${prefix}/operation/${operationId}`, row = (await state.read(key))!;
    const operation = row.value as Record<string, unknown>;
    const input = JSON.parse((await storage.readFile(operation.input_key as string))!);
    delete input.baselineSnapshot;
    const text = canonical(input), digest = hash(text), input_key = `${prefix}/legacy/${operationId}-${digest}.json`;
    await storage.writeFile(input_key, text);
    expect(await state.compareAndSet(key, row.revision, { ...operation, input_key, input_hash: digest })).toBe(true);
  }

  it.each(["false", "true", 0, 1, null, undefined])("rejects a non-Boolean enabled override instead of coercing %j", enabled => {
    expect(() => makeService({ config: { enabled } as unknown as Partial<SkillRestructureConfig> }))
      .toThrow("Invalid restructure configuration: enabled");
    expect(engine).not.toHaveBeenCalled();
  });

  it("retains an explicit false enabled override", async () => {
    await expect(makeService({ config: { enabled: false } }).submitCandidate(await candidate()))
      .rejects.toMatchObject({ code: "SKILL_RESTRUCTURE_DISABLED" });
    expect(engine).not.toHaveBeenCalled(); expect(ensureAsset).not.toHaveBeenCalled();
    expect((await state.list("skill-restructure/")).items).toEqual([]);
  });

  it.each([
    ["missing delimiter", "name: operations-guide\ndescription: Example\n# Procedure"],
    ["invalid YAML", "---\nname: [unterminated\n---\n# Procedure"],
    ["missing description", "---\nname: operations-guide\n---\n# Procedure"],
    ["invalid name", "---\nname: Invalid Name\ndescription: Example\n---\n# Procedure"],
  ])("returns a stable frontmatter error for %s without creating an operation", async (_label, content) => {
    const enqueue = vi.fn(async () => {});
    const service = makeService({ enqueue });
    await expect(service.submitCandidate({ ...actor, request_id: "invalid-frontmatter", force: true,
      candidate: { name: "operations-guide", content, resources: [] } })).rejects.toMatchObject({ code: "SKILL_FRONTMATTER_INVALID" });
    expect(engine).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled(); expect(ensureAsset).not.toHaveBeenCalled();
    expect((await state.list("skill-restructure/")).items).toEqual([]);
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(1);
  });

  it("retains the existing input-mismatch error for a valid frontmatter name differing from the candidate name", async () => {
    await expect(makeService().submitCandidate({ ...actor, request_id: "mismatched-name",
      candidate: { name: "operations-guide", content: doc("other-name", "# Procedure"), resources: [] } }))
      .rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
    expect((await state.list("skill-restructure/")).items).toEqual([]);
  });

  it("queues a fixed package snapshot without modifying a live skill", async () => {
    const service = makeService();
    const operation = await service.start({ ...actor, request_id: "inspect", skill_id: "skl-source", expected_version: 1 });
    expect(operation.status).toBe("queued"); expect(engine).not.toHaveBeenCalled();
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(1);
    expect((await core.list(actor)).total).toBe(1);
  });

  it("publishes children first, then one source version with real ID navigation and lineage", async () => {
    const result = await makeService().runCandidate(await candidate());
    expect(result.status).toBe("succeeded"); expect(result.outputs).toHaveLength(2);
    const parent = result.outputs.find(o => o.role === "root")!, child = result.outputs.find(o => o.role === "child")!;
    expect(parent).toMatchObject({ skill_id: "skl-source", version: 2 }); expect(child.version).toBe(1);
    const current = await core.get({ ...actor, skill_id: parent.skill_id });
    expect(current.content).toContain(child.skill_id); expect(current.content).not.toContain("{{skill:");
    expect(JSON.parse(current.metadata_json).user_note).toBe("retain");
    expect(JSON.parse(current.metadata_json).__skill_restructure.children[0].skill_id).toBe(child.skill_id);
    expect((await core.get({ ...actor, skill_id: parent.skill_id, version: 1 })).content).toContain("production changes.");
    expect((await core.search({ ...actor, query: "frontend" })).map(h => h.skill.skill_id)).toContain(child.skill_id);
    expect(ensureAsset).toHaveBeenCalledTimes(2);
  });

  it("replays the same operation after restart without another model call or version", async () => {
    const input = await candidate();
    const first = await makeService().runCandidate(input);
    const replay = await makeService().runCandidate(input);
    expect(replay.outputs).toEqual(first.outputs); expect(engine).toHaveBeenCalledTimes(1);
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(2);
  });

  it("rejects an idempotency key reused for different input", async () => {
    const service = makeService(), input = await candidate();
    await service.runCandidate(input);
    await expect(service.runCandidate({ ...input, candidate: { ...input.candidate, content: doc("operations-guide", "Changed") } }))
      .rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
  });

  it("does not overwrite a source changed while the model was working", async () => {
    engine.mockImplementationOnce(async snapshot => {
      await core.update({ ...actor, skill_id: "skl-source", expected_version: 1, content: doc("operations-guide", "New human-authored revision") });
      return approved(snapshot);
    });
    const result = await makeService().runCandidate(await candidate());
    expect(result.status).toBe("conflict");
    expect((await core.get({ ...actor, skill_id: "skl-source" })).content).toContain("human-authored");
    expect((await core.list(actor)).total).toBe(1);
  });

  it("resumes a partial publication without duplicating children or re-running the model", async () => {
    const input = await candidate();
    const original = core.applyPackageMutation.bind(core);
    const apply = vi.spyOn(core, "applyPackageMutation").mockRejectedValueOnce(new Error("temporary root publication failure"));
    const first = await makeService().runCandidate(input);
    expect(first.status).toBe("publishing");
    expect((await core.get({ ...actor, skill_id: "skl-source" })).version).toBe(1);
    expect((await core.list(actor)).total).toBe(2);
    apply.mockImplementation(original);
    const recovered = await makeService().process(first.operation_id);
    expect(recovered.status).toBe("succeeded"); expect(engine).toHaveBeenCalledTimes(1);
    expect((await core.list(actor)).total).toBe(2);
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(2);
  });

  it("recovers an acknowledged-lost source commit without reverting a later human update", async () => {
    const original = core.applyPackageMutation.bind(core);
    vi.spyOn(core, "applyPackageMutation").mockImplementationOnce(async input => { await original(input); throw new Error("response lost"); });
    const first = await makeService().runCandidate(await candidate());
    expect(first.status).toBe("publishing");
    await core.update({ ...actor, skill_id: "skl-source", expected_version: 2, content: doc("operations-guide", "Later human update") });
    const recovered = await makeService().process(first.operation_id);
    expect(recovered.status).toBe("succeeded"); expect(engine).toHaveBeenCalledTimes(1);
    expect((await core.get({ ...actor, skill_id: "skl-source" })).content).toContain("Later human update");
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(3);
  });

  it("keeps the live package when independent semantic review rejects the proposal", async () => {
    engine.mockRejectedValueOnce(Object.assign(new Error("A necessary rule was lost"), { code: "REVIEW_REJECTED" }));
    const result = await makeService().runCandidate(await candidate());
    expect(result.status).toBe("rejected"); expect(result.error?.code).toBe("REVIEW_REJECTED");
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(1);
    expect((await core.list(actor)).total).toBe(1);
  });

  it("keeps a small unchanged candidate without inventing a semantic review", async () => {
    await core.update({ ...actor, skill_id: "skl-source", expected_version: 1, content: doc("operations-guide", "Obtain approval before production changes.") });
    const source = await core.readPackage({ ...actor, skill_id: "skl-source", expected_version: 2 });
    const result = await makeService().runCandidate({ ...actor, request_id: "small", source: { skill_id: "skl-source", expected_version: 2 }, candidate: {
      name: source.skill.name, content: source.skill.content, resources: source.resources, metadata: JSON.parse(source.skill.metadata_json) } });
    expect(result.status).toBe("unchanged"); expect(engine).not.toHaveBeenCalled();
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(2);
  });

  it("accepts an unpublished over-limit candidate only after a reviewed rewrite", async () => {
    engine.mockImplementationOnce(async snapshot => approved(snapshot, false));
    const result = await makeService().runCandidate({ ...actor, request_id: "new-over-limit", candidate: {
      name: "new-procedure", content: doc("new-procedure", "Obtain approval before production changes.\n".repeat(1500)), resources: [] } });
    expect(result.status).toBe("succeeded");
    const root = result.outputs.find(o => o.role === "root")!;
    expect(root.version).toBe(1); expect(root.skill_id).not.toBe("skl-source");
    expect((await core.get({ ...actor, skill_id: root.skill_id })).content.length).toBeLessThan(50_000);
  });

  it.each(["disable-model-invocation: true", "user-invocable: false", "allowed-tools: Read", "x-owner: alice", "---extension: safe\npermissions: read-only"])("rejects removal of original frontmatter before review: %s", async field => {
    const content = doc("operations-guide", "Require approval.").replace("source: auto", `source: auto\n${field}`);
    await core.update({ ...actor, skill_id: "skl-source", expected_version: 1, content });
    const source = await core.readPackage({ ...actor, skill_id: "skl-source", expected_version: 2 });
    await expect(makeService().runCandidate({ ...actor, request_id: "guard", source: { skill_id: "skl-source", expected_version: 2 }, force: true,
      candidate: { name: source.skill.name, content: doc(source.skill.name, "Require approval."), resources: source.resources } }))
      .rejects.toMatchObject({ code: "SKILL_PROTECTED" });
    expect(engine).not.toHaveBeenCalled(); expect(ensureAsset).not.toHaveBeenCalled();
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(2);
    expect((await core.list(actor)).total).toBe(1);
  });

  it.each(["disable-model-invocation: false", "user-invocable: true", "hooks: {}"])("rejects unapproved guard introduction: %s", async field => {
    const input = await candidate();
    input.candidate.content = input.candidate.content.replace("source: auto", `source: auto\n${field}`);
    await expect(makeService().runCandidate(input)).rejects.toMatchObject({ code: "SKILL_PROTECTED" });
    expect(engine).not.toHaveBeenCalled();
  });

  it("rejects root renaming before creating children or invoking the model", async () => {
    const input = await candidate();
    input.candidate.name = "renamed"; input.candidate.content = input.candidate.content.replace("name: operations-guide", "name: renamed");
    await expect(makeService().runCandidate(input)).rejects.toMatchObject({ code: "SKILL_PROTECTED" });
    expect(engine).not.toHaveBeenCalled(); expect((await core.list(actor)).total).toBe(1);
  });

  it("inherits omitted original metadata while merging new fields", async () => {
    const input = await candidate(); input.force = false;
    input.candidate.content = doc("operations-guide", "Require approval."); input.candidate.metadata = { extracted_note: "new" };
    const result = await makeService().runCandidate(input);
    // The large PRIOR package now triggers preservation review even though this candidate is short.
    expect(result.status).toBe("succeeded"); expect(engine).toHaveBeenCalledTimes(1);
    expect(engine.mock.calls[0][1]?.baselineSnapshot?.content).toContain("Obtain approval before production changes.");
    expect(JSON.parse((await core.get({ ...actor, skill_id: "skl-source" })).metadata_json)).toMatchObject({ user_note: "retain", extracted_note: "new" });
  });

  it("rejects overwriting original user metadata before semantic review", async () => {
    const input = await candidate(); input.candidate.metadata = { user_note: "overwritten" };
    await expect(makeService().runCandidate(input)).rejects.toMatchObject({ code: "SKILL_PROTECTED" });
    expect(engine).not.toHaveBeenCalled(); expect(await store.countVersions("skl-source", actor.team_id)).toBe(1);
  });

  it.each([{ source: { external_managed: true } }, { source: "external-managed" }])("rejects protected new candidate metadata before review: %j", async metadata => {
    await expect(makeService().runCandidate({ ...actor, request_id: "external", force: true,
      candidate: { name: "external", content: doc("external", "Require approval."), resources: [], metadata } }))
      .rejects.toMatchObject({ code: "SKILL_PROTECTED" });
    expect(engine).not.toHaveBeenCalled(); expect((await core.list(actor)).total).toBe(1);
  });

  it("retains a last-attempt unknown commit for receipt recovery", async () => {
    const original = core.applyPackageMutation.bind(core);
    vi.spyOn(core, "applyPackageMutation")
      .mockRejectedValueOnce(new Error("temporary failure before commit"))
      .mockImplementationOnce(async input => { await original(input); throw Object.assign(new Error("acknowledgement lost"), { code: "SKILL_PUBLICATION_UNKNOWN" }); });
    const service = makeService(), first = await service.runCandidate(await candidate());
    const second = await service.process(first.operation_id);
    expect(second.status).toBe("publishing"); expect(second.outputs).toHaveLength(1);
    expect((await core.get({ ...actor, skill_id: "skl-source" })).version).toBe(2);
    await core.update({ ...actor, skill_id: "skl-source", expected_version: 2, content: doc("operations-guide", "Later human update") });
    now += 600_001;
    const recovered = await makeService().process(first.operation_id);
    expect(recovered.status).toBe("succeeded"); expect(recovered.outputs).toHaveLength(2);
    expect(engine).toHaveBeenCalledTimes(1);
    expect((await core.get({ ...actor, skill_id: "skl-source" })).content).toContain("Later human update");
  });

  it("preserves committed outputs while asset registration retries beyond model budgets", async () => {
    engine.mockImplementation(async snapshot => approved(snapshot, false));
    ensureAsset.mockRejectedValue(Object.assign(new Error("asset unavailable"), { code: "SKILL_ASSET_REGISTRATION_PENDING" }));
    const service = makeService({ config: { maxAttempts: 1 } });
    const first = await service.runCandidate(await candidate());
    expect(first.status).toBe("publishing"); expect(first.outputs).toMatchObject([{ role: "root", skill_id: "skl-source", version: 2 }]);
    now += 600_001;
    const second = await service.process(first.operation_id);
    expect(second.status).toBe("publishing"); expect(second.outputs).toEqual(first.outputs);
    ensureAsset.mockResolvedValue(undefined);
    expect((await service.process(first.operation_id)).status).toBe("succeeded");
    expect(engine).toHaveBeenCalledTimes(1); expect(await store.countVersions("skl-source", actor.team_id)).toBe(2);
  });

  it("still bounds model attempts before a plan exists", async () => {
    engine.mockRejectedValue(new Error("model unavailable"));
    const service = makeService(), first = await service.runCandidate(await candidate());
    expect(first.status).toBe("queued");
    const second = await service.process(first.operation_id);
    expect(second.status).toBe("failed");
    await service.process(first.operation_id);
    expect(engine).toHaveBeenCalledTimes(2); expect(await store.countVersions("skl-source", actor.team_id)).toBe(1);
  });

  it("restores committed records with current asset metadata rather than a later human revision's old title", async () => {
    engine.mockImplementation(async snapshot => approved(snapshot, false));
    ensureAsset.mockRejectedValueOnce(new Error("asset registration interrupted"));
    const first = await makeService().runCandidate(await candidate());
    const current = await core.update({ ...actor, skill_id: "skl-source", expected_version: 2,
      content: doc("operations-guide", "Human update").replace("description: A reusable procedure", "description: Human updated description") });
    const recovered = await makeService().process(first.operation_id);
    expect(recovered.status).toBe("succeeded");
    expect(ensureAsset).toHaveBeenLastCalledWith(expect.objectContaining({ version: current.version, description: "Human updated description" }));
    expect(recovered.outputs.find(output => output.role === "root")?.version).toBe(2);
  });

  it("requeues one bounded page without reading package blobs and resumes via a caller-owned cursor", async () => {
    const service = makeService();
    const queued = await Promise.all(Array.from({ length: 5 }, (_, i) => service.submitCandidate({ ...actor, request_id: `requeue-${i}`,
      candidate: { name: `requeue-${i}`, content: doc(`requeue-${i}`, "Require approval."), resources: [] } })));
    queued.sort((a, b) => a.operation_id.localeCompare(b.operation_id));
    const prefix = `skill-restructure/${hash("instance")}`;
    await service.process(queued[0].operation_id);
    await state.create(`${prefix}/pending/${queued[0].operation_id}`, { operation_id: queued[0].operation_id });
    for (const [index, update] of [[1, { lease_token: "other-worker", lease_until_ms: now + 30_000 }], [2, { next_attempt_at_ms: now + 30_000 }]] as const) {
      const key = `${prefix}/operation/${queued[index].operation_id}`, row = (await state.read(key))!;
      await state.compareAndSet(key, row.revision, { ...(row.value as object), ...update });
    }
    const missingKey = `${prefix}/operation/${queued[3].operation_id}`, missing = (await state.read(missingKey))!;
    await state.remove(missingKey, missing.revision);
    const readBlob = vi.spyOn(storage, "readFile");
    const enqueue = vi.fn(async (_operation: unknown, _actor: unknown) => {});
    const first = await makeService({ enqueue }).requeuePending({ limit: 2 });
    expect(first).toEqual({ enqueued: 0, next: expect.any(String) });
    const second = await makeService({ enqueue }).requeuePending({ limit: 2, after: first.next });
    expect(second).toEqual({ enqueued: 0, next: expect.any(String) });
    const third = await makeService({ enqueue }).requeuePending({ limit: 2, after: second.next });
    expect(third).toEqual({ enqueued: 1 });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(queued[4], actor);
    expect(readBlob).not.toHaveBeenCalled(); expect(engine).not.toHaveBeenCalled();
    for (const index of [0, 3]) expect(await state.read(`${prefix}/pending/${queued[index].operation_id}`)).toBeNull();
    for (const index of [1, 2, 4]) expect(await state.read(`${prefix}/pending/${queued[index].operation_id}`)).not.toBeNull();
  });

  it("retains pending work if enqueue fails and retries after a new service is constructed", async () => {
    const queued = await makeService().submitCandidate(await candidate());
    const enqueue = vi.fn(async () => { throw new Error("queue unavailable"); });
    await expect(makeService({ enqueue }).requeuePending()).rejects.toThrow("queue unavailable");
    expect((await makeService().get({ ...actor, operation_id: queued.operation_id })).status).toBe("queued");
    expect(await state.read(`skill-restructure/${hash("instance")}/pending/${queued.operation_id}`)).not.toBeNull();
    const accepted = vi.fn(async () => {});
    expect(await makeService({ enqueue: accepted }).requeuePending()).toEqual({ enqueued: 1 });
    expect(accepted).toHaveBeenCalledExactlyOnceWith(queued, actor);
    expect(engine).not.toHaveBeenCalled();
  });

  it("does not report work enqueued when no queue callback is configured", async () => {
    const queued = await makeService().submitCandidate(await candidate());
    expect(await makeService().requeuePending()).toEqual({ enqueued: 0 });
    expect(await state.read(`skill-restructure/${hash("instance")}/pending/${queued.operation_id}`)).not.toBeNull();
    expect(engine).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1001, 1.5, NaN])("rejects an invalid pending page limit: %s", async limit => {
    await expect(makeService().requeuePending({ limit })).rejects.toThrow("Recovery limit must be 1..1000");
  });

  it("blocks unprepared work while disabled without consuming an attempt or enqueueing it", async () => {
    const queued = await makeService().submitCandidate(await candidate());
    const enqueue = vi.fn(async () => {}), service = makeService({ enqueue, config: { enabled: false } });
    expect(await service.requeuePending()).toEqual({ enqueued: 0 });
    expect(await service.recover()).toEqual([]);
    await expect(service.process(queued.operation_id)).rejects.toMatchObject({ code: "SKILL_RESTRUCTURE_DISABLED" });
    expect(await service.get({ ...actor, operation_id: queued.operation_id })).toMatchObject({ status: "queued", attempts: 0 });
    expect(enqueue).not.toHaveBeenCalled(); expect(engine).not.toHaveBeenCalled();
  });

  it.each(["prepared", "committed"] as const)("requeues and recovers %s publication after disabling new semantic work", async stage => {
    engine.mockImplementation(async snapshot => approved(snapshot, false));
    if (stage === "prepared") vi.spyOn(core, "applyPackageMutation").mockRejectedValueOnce(new Error("publication paused before commit"));
    else ensureAsset.mockRejectedValueOnce(new Error("asset registration interrupted after commit"));
    const first = await makeService().runCandidate(await candidate());
    expect(first.status).toBe("publishing");
    expect((await core.get({ ...actor, skill_id: "skl-source" })).version).toBe(stage === "prepared" ? 1 : 2);
    const enqueue = vi.fn(async () => {});
    const runner = vi.fn(async () => { throw new Error("disabled recovery must not resolve a model"); });
    const service = makeService({ enqueue, runner, config: { enabled: false } });
    expect(await service.requeuePending()).toEqual({ enqueued: 1 });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(first, actor);
    const recovered = await service.process(first.operation_id);
    expect(recovered.status).toBe("succeeded");
    expect(recovered.outputs).toMatchObject([{ skill_id: "skl-source", version: 2, role: "root" }]);
    expect(engine).toHaveBeenCalledTimes(1); expect(runner).not.toHaveBeenCalled();
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(2);
    const key = `skill-restructure/${hash("instance")}/pending/${first.operation_id}`;
    await state.create(key, { operation_id: first.operation_id });
    expect((await service.process(first.operation_id)).status).toBe("succeeded");
    expect(await state.read(key)).toBeNull();
  });

  it("cleans a terminal pending marker even through process's early return", async () => {
    const service = makeService(), result = await service.runCandidate(await candidate());
    const key = `skill-restructure/${hash("instance")}/pending/${result.operation_id}`;
    await state.create(key, { operation_id: result.operation_id });
    expect((await service.process(result.operation_id)).status).toBe("succeeded");
    expect(await state.read(key)).toBeNull();
  });

  it("recovers work behind terminal remnants and leased entries instead of stopping on page one", async () => {
    const service = makeService();
    const queued = await Promise.all(Array.from({ length: 5 }, (_, i) => service.submitCandidate({ ...actor, request_id: `recover-${i}`,
      candidate: { name: `recover-${i}`, content: doc(`recover-${i}`, "Require approval."), resources: [] } })));
    queued.sort((a, b) => a.operation_id.localeCompare(b.operation_id));
    const prefix = `skill-restructure/${hash("instance")}`;
    for (const item of queued.slice(0, 3)) {
      await service.process(item.operation_id);
      await state.create(`${prefix}/pending/${item.operation_id}`, { operation_id: item.operation_id });
    }
    const leasedKey = `${prefix}/operation/${queued[3].operation_id}`, leased = (await state.read(leasedKey))!;
    await state.compareAndSet(leasedKey, leased.revision, { ...(leased.value as object), lease_token: "other-worker", lease_until_ms: now + 30_000 });
    const recovered = await service.recover(undefined, 1);
    expect(recovered.map(result => result.operation_id)).toEqual([queued[4].operation_id]);
    expect(recovered[0].status).toBe("succeeded");
    for (const item of queued.slice(0, 3)) expect(await state.read(`${prefix}/pending/${item.operation_id}`)).toBeNull();
    expect(await state.read(`${prefix}/pending/${queued[3].operation_id}`)).not.toBeNull();
  });

  it("keeps root commit evidence when a child was deleted before acknowledged-lost recovery", async () => {
    const apply = core.applyPackageMutation.bind(core);
    vi.spyOn(core, "applyPackageMutation").mockImplementationOnce(async input => { await apply(input); throw new Error("root response lost"); });
    const first = await makeService().runCandidate(await candidate());
    const child = first.outputs.find(output => output.role === "child")!;
    await core.delete({ ...actor, skill_id: child.skill_id });
    const recovered = await makeService().process(first.operation_id);
    expect(recovered.status).toBe("conflict");
    expect(recovered.outputs).toContainEqual(expect.objectContaining({ role: "root", skill_id: "skl-source", version: 2 }));
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(2);
    expect(engine).toHaveBeenCalledTimes(1);
    await expect(core.get({ ...actor, skill_id: child.skill_id })).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("bounds each recovery scan and continues beyond leased entries on the next tick", async () => {
    const service = makeService(), queued = await service.submitCandidate({ ...actor, request_id: "behind-many-leases",
      candidate: { name: "queued", content: doc("queued", "Require approval."), resources: [] } });
    const prefix = `skill-restructure/${hash("instance")}`;
    const original = (await state.read(`${prefix}/operation/${queued.operation_id}`))!.value as object;
    for (let i = 0; i < 1000; i++) {
      const operation_id = `sro-${i.toString(16).padStart(32, "0")}`;
      await state.create(`${prefix}/operation/${operation_id}`, { ...original, operation_id, lease_token: "other-worker", lease_until_ms: now + 30_000 });
      await state.create(`${prefix}/pending/${operation_id}`, { operation_id });
    }
    const read = vi.spyOn(state, "read");
    expect(await service.recover(undefined, 1)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1000);
    expect((await service.recover(undefined, 1)).map(result => result.operation_id)).toEqual([queued.operation_id]);
  });

  it("does not scan or claim recovery work after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    const list = vi.spyOn(state, "list");
    expect(await makeService().recover(controller.signal, 1)).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["", " user", "user ", `u${String.fromCharCode(0)}ser`, `u${String.fromCharCode(127)}ser`, "u".repeat(257), 123, null])("rejects malformed actor values before persisting unpublished candidates: %j", async value => {
    const create = vi.spyOn(state, "create");
    await expect(makeService().submitCandidate({ ...actor, user_id: value as string, request_id: "bad-actor",
      candidate: { name: "new", content: doc("new", "Require approval."), resources: [] } }))
      .rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    expect(create).not.toHaveBeenCalled();
  });

  it("enqueues submitCandidate and idempotent retries, but never the inline runCandidate path", async () => {
    const enqueue = vi.fn(async () => {}), service = makeService({ enqueue }), input = await candidate();
    const queued = await service.submitCandidate(input);
    await service.submitCandidate(input);
    expect(enqueue).toHaveBeenCalledTimes(2); expect(enqueue).toHaveBeenLastCalledWith(queued, actor);
    enqueue.mockClear();
    expect((await service.runCandidate(input)).status).toBe("succeeded");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(["update", "delete"] as const)("rechecks child heads after asset awaits before source publication with the real engine: %s", async change => {
    const approval = "Obtain approval before production changes.", childText = "For keyboard reviews, inspect keyboard access.";
    const content = doc("operations-guide", `${approval}\n${childText}`);
    await core.update({ ...actor, skill_id: "skl-source", expected_version: 1, content });
    const source = await core.readPackage({ ...actor, skill_id: "skl-source", expected_version: 2 });
    let calls = 0;
    const runner: RestructureRunner = { run: async params => {
      calls++;
      const execute = async (name: string, args: unknown): Promise<any> => {
        const tool = params.tools![name] as { execute(args: unknown, context: unknown): Promise<unknown> };
        return tool.execute(args, { toolCallId: "publication-regression", messages: [] });
      };
      const index = await execute("read_source", { ids: [] });
      for (const block of index.blocks) if (block.kind === "text") await execute("read_source", { ids: [block.id] });
      const ids = index.blocks.filter((block: { kind: string; path: string }) => block.kind === "text" && block.path === "SKILL.md").map((block: { id: string }) => block.id);
      const rootTarget = { packageKey: "root", path: "SKILL.md", quote: approval };
      const childTarget = { packageKey: "keyboard-review", path: "SKILL.md", quote: childText };
      if (params.tools!.submit_draft) {
        await execute("submit_draft", { kind: "restructure", rationale: "Separate the independently invoked keyboard review.",
          root: { key: "root", name: "operations-guide", content: doc("operations-guide", `${approval}\nLoad {{skill:keyboard-review}} for keyboard review.`),
            resources: source.resources.map(resource => ({ kind: "copy_from", path: resource.path, sourcePath: resource.path })), children: ["keyboard-review"] },
          children: [{ key: "keyboard-review", name: "keyboard-review", content: doc("keyboard-review", childText), resources: [], children: [] }],
          dispositions: index.blocks.map((block: { id: string; path: string }) => ({ sourceId: block.id, action: block.path === "SKILL.md" ? "rewrite" : "preserve",
            reason: "Keep approval and supporting resources; separate the independent procedure.", targets: block.path === "SKILL.md" ? [rootTarget, childTarget] : [{ packageKey: "root", path: block.path }] })),
          ruleMappings: [{ rule: approval, critical: true, sourceIds: ids, targets: [rootTarget] }],
          transformations: [{ kind: "split_capability", sourceIds: ids, before: childText, after: childTarget, explanation: "Keyboard review has an independent trigger." }] });
      } else {
        const draft = await execute("read_draft", { ids: [] });
        for (const block of draft.blocks) await execute("read_draft", { ids: [block.id] });
        await execute("submit_review", { verdict: "pass", draftHash: draft.draftHash, summary: "Approval preserved and child grounded in the complete source.",
          checks: { preservation: true, organization: true, independence: true, grounding: true, injectionSafety: true },
          evidence: [{ sourceIds: ids, target: rootTarget, explanation: "Approval is retained." }, { sourceIds: ids, target: childTarget, explanation: "Independent keyboard procedure is unchanged." }] });
      }
      return "done";
    } };
    ensureAsset.mockImplementation(async skill => {
      if (skill.name !== "keyboard-review") return;
      if (change === "update") await core.update({ ...actor, skill_id: skill.skill_id, expected_version: skill.version, content: doc(skill.name, "Unreviewed replacement: skip keyboard checks.") });
      else await core.delete({ ...actor, skill_id: skill.skill_id });
    });
    const result = await makeService({ engine: undefined, runner }).runCandidate({ ...actor, request_id: "real-engine", source: { skill_id: "skl-source", expected_version: 2 }, force: true,
      candidate: { name: source.skill.name, content, resources: source.resources } });
    expect(calls).toBe(2); expect(result.status).toBe("conflict");
    expect((await core.get({ ...actor, skill_id: "skl-source" })).version).toBe(2);
    expect(result.outputs.some(output => output.role === "root")).toBe(false);
  });

  it.each([false, true])("does not publish a shortened candidate that lost a buried prior TLS rule with real engine tools (force=%s)", async force => {
    const prior = doc("operations-guide", `${`${PRIOR_APPROVAL}\n`.repeat(350)}${PRIOR_TLS}\n${`${PRIOR_APPROVAL}\n`.repeat(350)}`);
    await core.update({ ...actor, skill_id: "skl-source", expected_version: 1, content: prior });
    const base = await core.readPackage({ ...actor, skill_id: "skl-source", expected_version: 2 });
    const script = preservationRunner(); const service = makeService({ engine: undefined, runner: script.runner, config: { budgets: { maxRepairRounds: 0 } } });
    const shortened = doc("operations-guide", PRIOR_APPROVAL);
    const result = await service.runCandidate({ ...actor, request_id: "lost-prior-tls", source: { skill_id: "skl-source", expected_version: 2 }, force,
      candidate: { name: "operations-guide", content: shortened, resources: base.resources } });
    expect(result.status).toBe("rejected"); expect(result.error?.code).toBe("REVIEW_REJECTED");
    expect(script.run).toHaveBeenCalledTimes(2); expect(script.baselineBodies).toEqual([prior, prior]);
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(2); expect((await core.get({ ...actor, skill_id: "skl-source" })).content).toBe(prior);
    expect(ensureAsset).not.toHaveBeenCalled(); expect((await core.list(actor)).total).toBe(1);
    const stored = (await state.read(`skill-restructure/${hash("instance")}/operation/${result.operation_id}`))!.value as { input_key: string };
    const blob = JSON.parse((await storage.readFile(stored.input_key))!);
    expect(blob.snapshot.content).toBe(shortened); expect(blob.baselineSnapshot.content).toBe(prior);
  });

  it("accepts a legitimate compact addition preserving prior rules without forcing old binary copies", async () => {
    const prior = doc("operations-guide", `${`${PRIOR_APPROVAL}\n`.repeat(700)}${PRIOR_TLS}`);
    await core.applyPackageMutation({ ...actor, skill_id: "skl-source", expected_version: 1, mutation_id: "prior-assets", content: prior,
      resources: [{ path: "assets/old.bin", content: "AP8=", encoding: "base64", mime_type: "application/octet-stream", is_executable: false }] });
    const script = preservationRunner(); const service = makeService({ engine: undefined, runner: script.runner });
    const content = doc("operations-guide", `${PRIOR_APPROVAL}\n${PRIOR_TLS}\nRecord request IDs after successful checks.`);
    const result = await service.runCandidate({ ...actor, request_id: "legitimate-addition", source: { skill_id: "skl-source", expected_version: 2 },
      candidate: { name: "operations-guide", content, resources: [{ path: "assets/new.bin", content: "AQI=", encoding: "base64", mime_type: "application/octet-stream", is_executable: false }] } });
    expect(result.status).toBe("succeeded"); expect(script.run).toHaveBeenCalledTimes(2);
    const published = await core.readPackage({ ...actor, skill_id: "skl-source", expected_version: 3 });
    expect(published.skill.content).toBe(content); expect(published.resources.map(resource => resource.path)).toEqual(["assets/new.bin"]);
    expect(published.resources[0].content).toBe("AQI=");
  });

  it("does not reuse a candidate-only cached judgment after its original baseline changes", async () => {
    const short = doc("operations-guide", PRIOR_APPROVAL);
    await core.update({ ...actor, skill_id: "skl-source", expected_version: 1, content: short });
    const script = preservationRunner(); const service = makeService({ engine: undefined, runner: script.runner, config: { budgets: { maxRepairRounds: 0 } } });
    const first = await service.start({ ...actor, request_id: "cache-short", skill_id: "skl-source", expected_version: 2 });
    expect((await service.process(first.operation_id)).status).toBe("unchanged"); expect(script.run).toHaveBeenCalledTimes(2);
    const prior = doc("operations-guide", `${`${PRIOR_APPROVAL}\n`.repeat(700)}${PRIOR_TLS}`);
    await core.update({ ...actor, skill_id: "skl-source", expected_version: 2, content: prior });
    const base = await core.readPackage({ ...actor, skill_id: "skl-source", expected_version: 3 });
    const result = await service.runCandidate({ ...actor, request_id: "same-candidate-new-baseline", source: { skill_id: "skl-source", expected_version: 3 },
      candidate: { name: "operations-guide", content: short, resources: base.resources } });
    expect(result.status).toBe("rejected"); expect(script.run).toHaveBeenCalledTimes(4);
    expect((await core.get({ ...actor, skill_id: "skl-source" })).content).toBe(prior);
  });

  it("refuses an unprepared legacy update without guessing its missing original baseline", async () => {
    const service = makeService(), input = await candidate("legacy-unprepared"); input.candidate.content = doc("operations-guide", PRIOR_APPROVAL);
    const queued = await service.submitCandidate(input);
    await simulateLegacyInputWithoutBaseline(queued.operation_id);
    const result = await service.process(queued.operation_id);
    expect(result.status).toBe("rejected"); expect(result.error?.code).toBe("REVIEW_REJECTED");
    expect(engine).not.toHaveBeenCalled(); expect(await store.countVersions("skl-source", actor.team_id)).toBe(1);
  });

  it("retains a prepared plan when quota blocks new writes and resumes without another model call", async () => {
    const beforePublish = vi.fn(async () => {});
    beforePublish.mockRejectedValueOnce(Object.assign(new Error("Memory limit exceeded (current=1, limit=1)"), { code: "SKILL_QUOTA_EXCEEDED" }));
    const service = makeService({ beforePublish });
    const input = await candidate(); input.candidate.content = doc("operations-guide", PRIOR_APPROVAL);
    const first = await service.runCandidate(input);
    expect(first.status).toBe("publishing"); expect(first.error?.code).toBe("SKILL_QUOTA_EXCEEDED");
    expect(await store.countVersions("skl-source", actor.team_id)).toBe(1); expect((await core.list(actor)).total).toBe(1); expect(ensureAsset).not.toHaveBeenCalled();
    // A prepared plan from the old schema remains recoverable even without original-package context.
    await simulateLegacyInputWithoutBaseline(first.operation_id);
    const recovered = await service.process(first.operation_id);
    expect(recovered.status).toBe("succeeded"); expect(engine).toHaveBeenCalledTimes(1);
    expect(beforePublish).toHaveBeenCalledTimes(3); expect(await store.countVersions("skl-source", actor.team_id)).toBe(2);
  });

  it("rechecks child dependencies after an asynchronous quota preflight before publishing the root", async () => {
    let calls = 0;
    const beforePublish = vi.fn(async () => {
      if (++calls !== 2) return;
      const child = (await core.list(actor)).items.find(skill => skill.name === "frontend-review")!;
      await core.update({ ...actor, skill_id: child.skill_id, expected_version: child.version, content: doc(child.name, "Unreviewed replacement after the quota await.") });
    });
    const result = await makeService({ beforePublish }).runCandidate(await candidate());
    expect(result.status).toBe("conflict"); expect(result.outputs.some(output => output.role === "root")).toBe(false);
    expect((await core.get({ ...actor, skill_id: "skl-source" })).version).toBe(1);
  });

  it("bypasses quota only for committed receipt replay and asset repair", async () => {
    engine.mockImplementation(async snapshot => approved(snapshot, false));
    const beforePublish = vi.fn(async () => {}); ensureAsset.mockRejectedValueOnce(new Error("asset registration interrupted"));
    const service = makeService({ beforePublish });
    const first = await service.runCandidate(await candidate());
    expect(first.status).toBe("publishing"); expect(first.outputs).toHaveLength(1); expect(beforePublish).toHaveBeenCalledTimes(1);
    beforePublish.mockRejectedValue(Object.assign(new Error("quota now exhausted"), { code: "SKILL_QUOTA_EXCEEDED" }));
    expect((await service.process(first.operation_id)).status).toBe("succeeded");
    expect(beforePublish).toHaveBeenCalledTimes(1); expect(engine).toHaveBeenCalledTimes(1); expect(await store.countVersions("skl-source", actor.team_id)).toBe(2);
  });

  it.each(["start", "submitCandidate"] as const)("runs %s beforeSubmit only for a new intent, never accepted replay or conflicts", async method => {
    const service = makeService(); const beforeSubmit = vi.fn(async () => {});
    const error = Object.assign(new Error("Memory limit exceeded (current=1, limit=1)"), { code: "SKILL_QUOTA_EXCEEDED" });
    beforeSubmit.mockRejectedValueOnce(error);
    const input = await candidate("submission-quota");
    const start = { ...actor, request_id: input.request_id, skill_id: "skl-source", expected_version: 1 };
    const invoke = () => method === "start" ? service.start(start, beforeSubmit) : service.submitCandidate(input, beforeSubmit);
    const writes = vi.spyOn(storage, "writeFile");
    await expect(invoke()).rejects.toMatchObject({ code: "SKILL_QUOTA_EXCEEDED" });
    expect(writes).not.toHaveBeenCalled(); expect((await state.list("skill-restructure/")).items).toEqual([]);
    const queued = await invoke(); const published = await service.process(queued.operation_id);
    expect(published.status).toBe("succeeded"); beforeSubmit.mockRejectedValue(error);
    expect((await invoke()).operation_id).toBe(published.operation_id); expect(beforeSubmit).toHaveBeenCalledTimes(2);
    if (method === "start") await expect(service.start({ ...start, reason: "different intent" }, beforeSubmit)).rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    else await expect(service.submitCandidate({ ...input, force: false }, beforeSubmit)).rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    expect(beforeSubmit).toHaveBeenCalledTimes(2);
  });

  it.each(["operation", "batch"] as const)("uses distinct immutable blob keys for concurrent same-content %s submissions", async kind => {
    const service = makeService(); const input = await candidate("same-content");
    const writes = vi.spyOn(storage, "writeFile");
    if (kind === "operation") {
      const [first, second] = await Promise.all([service.submitCandidate(input), service.submitCandidate(input)]);
      expect(first.operation_id).toBe(second.operation_id);
      const control = (await state.read(`skill-restructure/${hash("instance")}/operation/${first.operation_id}`))!.value as { input_key: string; input_hash: string };
      const keys = writes.mock.calls.map(([key]) => key);
      expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(2);
      expect(keys.filter(key => key === control.input_key)).toHaveLength(1);
      const frozen = (await storage.readFile(control.input_key))!;
      expect(hash(frozen)).toBe(control.input_hash); expect(JSON.parse(frozen).snapshot.content).toBe(input.candidate.content);
      await service.submitCandidate(input);
      expect(writes).toHaveBeenCalledTimes(2); expect(await storage.readFile(control.input_key)).toBe(frozen);
    } else {
      const batch = { ...actor, request_id: "same-content-batch", input_hash: "original-input", candidates: [input] };
      const [first, second] = await Promise.all([service.freezeDraftBatch(batch), service.freezeDraftBatch(batch)]);
      expect(first).toEqual(second); expect(first.candidates).toEqual([input]);
      const keys = writes.mock.calls.map(([key]) => key);
      expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(2);
      const control = (await state.list(`skill-restructure/${hash("instance")}/batch/`)).items[0].value as { key: string; hash: string };
      expect(keys.filter(key => key === control.key)).toHaveLength(1);
      const frozen = (await storage.readFile(control.key))!;
      expect(hash(frozen)).toBe(control.hash); expect(JSON.parse(frozen)).toEqual(first);
      await service.freezeDraftBatch(batch);
      expect(writes).toHaveBeenCalledTimes(2); expect(await storage.readFile(control.key)).toBe(frozen);
    }
  });

  it("freezes the first complete extraction batch and scopes subsequent reads", async () => {
    const service = makeService(), input = await candidate();
    const batch = { ...actor, request_id: "archive-a", input_hash: "same-original-input", candidates: [input] };
    await service.freezeDraftBatch(batch);
    const competing = await service.freezeDraftBatch({ ...batch, candidates: [] });
    expect(competing.candidates).toEqual([input]);
    expect((await service.loadDraftBatch(batch))?.candidates).toEqual([input]);
    await expect(service.loadDraftBatch({ ...batch, input_hash: "different-original-input" })).rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    expect(await service.loadDraftBatch({ ...batch, user_id: "other-user" })).toBeNull();
  });
});
