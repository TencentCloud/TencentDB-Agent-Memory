import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoSkillStore } from "../core/store/mongodb/skill-store.js";
import type { MongoClientPool } from "../core/store/mongodb/client-pool.js";
import { TdaiGateway } from "./server.js";
import { TdaiCore } from "../core/tdai-core.js";
import { parseConfig } from "../config.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { StandaloneLLMRunner } from "../adapters/standalone/llm-runner.js";
import * as llmResolver from "../adapters/standalone/llm-provider-resolver.js";
import type { LLMRunParams } from "../core/types.js";
import type { SkillCore } from "../core/skill/skill-core.js";
import type { SkillExtractor } from "../core/skill/skill-extractor.js";
import type { SkillRestructureService } from "../core/skill/skill-restructure-service.js";
import type { SkillRestructureRecovery } from "../core/skill/skill-restructure-recovery.js";
import type { SkillRestructureOperation } from "../core/skill/skill-restructure-types.js";
import type { SkillWorkerPool } from "../core/skill/conversation-add/worker-pool.js";
import type { MetadataService } from "../metadata/service/metadata-service.js";

const rule = "Never run destructive commands without explicit approval.";
const narrative = "Yesterday I spent two hours checking a service and then it worked.";
const doc = (body: string) => `---\nname: safe-operations\ndescription: Diagnose operations safely.\nsource: auto\n---\n\n${body}`;
const source = doc(`${rule}\n${`${narrative}\n`.repeat(500)}`);
const rewritten = doc(`${rule}\nCollect timings, compare the baseline, and verify recovery.\n`);
const frontendRule = "For frontend accessibility review, test keyboard-only navigation and visible focus, then report failures.";
let splitCapabilities = false;

type Runtime = {
  core: TdaiCore;
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
  buildSkillExtractorForInstance(core: SkillCore, instanceId: string): Promise<SkillExtractor>;
  resolveSkillRestructureForInstance(instanceId: string, core?: SkillCore): Promise<SkillRestructureService>;
  ensureMetadataService(instanceId: string): Promise<MetadataService>;
  skillWorkerPool: SkillWorkerPool | null;
  skillRestructureRecovery?: SkillRestructureRecovery;
  config: { llm: { apiKey: string } };
  stopPromise: Promise<void> | null;
  ensureSkillWorkerPool(): Promise<SkillWorkerPool | null>;
  resolveSkillCoreForInstance(instanceId: string): Promise<SkillCore>;
  trackSkillRecoveryInstance(instanceId: string): void;
};
type Block = { id: string; path: string; kind: string };
async function call(params: LLMRunParams, name: string, args: unknown): Promise<any> {
  const tool = params.tools![name] as { execute(args: unknown, context: unknown): Promise<unknown> };
  const result = await tool.execute(args, { toolCallId: "runtime-fixture", messages: [] });
  return typeof result === "string" ? JSON.parse(result) : result;
}
async function scriptedModel(params: LLMRunParams): Promise<string> {
  if (params.tools?.skill_create) {
    const staged = await call(params, "skill_create", { name: "safe-operations", content: source });
    expect(staged.draft_id).toMatch(/^draft:/);
    expect(staged.skill_id).toBeUndefined();
    return "Prepared a private draft.";
  }
  if (!params.tools?.read_source) return "safe operations";
  const index = await call(params, "read_source", { ids: [] });
  const blocks = index.blocks as Block[];
  for (const block of blocks) if (block.kind === "text") await call(params, "read_source", { ids: [block.id] });
  const baseline = params.tools.read_baseline ? await call(params, "read_baseline", { ids: [] }) : undefined;
  if (baseline) for (const block of baseline.blocks as Block[]) {
    if (block.kind === "text") await call(params, "read_baseline", { ids: [block.id] });
  }
  const target = { packageKey: "root", path: "SKILL.md", quote: rule };
  const childTarget = { packageKey: "frontend", path: "SKILL.md", quote: frontendRule };
  if (params.tools.submit_review) {
    const draft = await call(params, "read_draft", { ids: [] });
    for (const block of draft.blocks) await call(params, "read_draft", { ids: [block.id] });
    await call(params, "submit_review", { verdict: "pass", draftHash: draft.draftHash,
      ...(baseline ? { baselineFingerprint: baseline.baselineFingerprint } : {}),
      summary: "Scripted integration fixture: safety is retained and repeated incident narration is removed.",
      checks: { preservation: true, organization: true, independence: true, grounding: true, injectionSafety: true },
      evidence: [{ sourceIds: [blocks[0].id], target, explanation: "The root retains the explicit approval prohibition." },
        ...(baseline ? [{ sourceIds: [baseline.blocks[0].id], target, explanation: "The original package's approval prohibition survives the complete candidate rewrite." }] : []),
        ...(splitCapabilities ? [{ sourceIds: [blocks[blocks.length - 1].id], target: childTarget, explanation: "The separate frontend workflow is retained in its own capability." },
          ...(baseline ? [{ sourceIds: [baseline.blocks[baseline.blocks.length - 1].id], target: childTarget, explanation: "The original frontend capability is preserved independently." }] : [])] : [])] });
    return "Reviewed the frozen draft.";
  }
  await call(params, "submit_draft", {
    kind: "restructure", rationale: "Consolidate the repeated incident narration into a reusable diagnosis procedure.",
    root: { key: "root", name: "safe-operations", content: rewritten + (splitCapabilities ? "\nFor frontend accessibility use {{skill:frontend}}.\n" : ""), resources: [], children: splitCapabilities ? ["frontend"] : [] },
    children: splitCapabilities ? [{ key: "frontend", name: "frontend-accessibility", content: `---\nname: frontend-accessibility\ndescription: Review keyboard access and focus visibility.\nsource: auto\n---\n\n${frontendRule}\n[Checklist](references/accessibility.md)\n`,
      resources: [{ kind: "write", path: "references/accessibility.md", content: frontendRule, encoding: "utf-8" }], children: [] }] : [],
    dispositions: blocks.map(block => ({ sourceId: block.id, action: "rewrite", reason: "Retain durable rules instead of repeated chronology.", targets: [target, ...(splitCapabilities ? [childTarget] : [])] })),
    ruleMappings: [{ rule, critical: true, sourceIds: [blocks[0].id], targets: [target] },
      ...(splitCapabilities ? [{ rule: frontendRule, critical: true, scope: "package", ownerPackageKey: "frontend", sourceIds: [blocks[blocks.length - 1].id], targets: [childTarget] }] : [])],
    transformations: [{ kind: "remove_narrative", sourceIds: blocks.map(block => block.id), before: narrative,
      explanation: "Repeated incident chronology carries no further durable constraint.", after: target },
      ...(splitCapabilities ? [{ kind: "split_capability", sourceIds: [blocks[blocks.length - 1].id], before: frontendRule, after: childTarget, explanation: "Frontend accessibility has a distinct trigger and can run independently from production diagnosis." }] : [])],
  });
  return "Submitted a rewrite.";
}

describe("assembled skill restructuring runtime", () => {
  let dir: string, db: DatabaseSync, storage: StorageAdapter, gateway: TdaiGateway, runtime: Runtime;
  let server: http.Server, baseUrl: string;
  let model: ReturnType<typeof vi.spyOn>;
  let memory: ReturnType<typeof parseConfig>;
  beforeEach(async () => {
    splitCapabilities = false;
    dir = await mkdtemp(join(tmpdir(), "skill-runtime-"));
    vi.stubEnv("TDAI_METADATA_SQLITE_BASE_DIR", join(dir, "metadata"));
    vi.stubEnv("TDAI_METADATA_MONGO_URI", "");
    vi.stubEnv("TDAI_V3_STRICT_ISOLATION", "false");
    memory = parseConfig({ storeBackend: "sqlite", embedding: { enabled: false }, extraction: { enabled: false },
      llm: { enabled: true, provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-test-key", model: "memory-model", maxTokens: 5678 },
      skill: { enabled: true, extraction: { enabled: true, model: "skill-model", prefixSkillsLimit: 1 },
        worker: { concurrency: 1, brpopBlockMs: 20 }, restructure: { retryDelayMs: 0 } } });
    model = vi.spyOn(StandaloneLLMRunner.prototype, "run").mockImplementation(scriptedModel);
    await openRuntime();
  });
  async function openRuntime(apiKey = "synthetic-test-key") {
    storage = new StorageAdapter(new LocalStorageBackend(dir));
    gateway = new TdaiGateway({ deployMode: "standalone", instanceId: "default", memory: { ...memory, llm: { ...memory.llm, apiKey } },
      server: { apiKey: "runtime-test-key", port: 0, host: "127.0.0.1" }, data: { baseDir: dir, fileStore: "local" },
      llm: { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey, model: "memory-model", maxTokens: 5678 } });
    runtime = gateway as unknown as Runtime;
    db = new DatabaseSync(join(dir, "skills.sqlite"));
    Object.assign(runtime.core, { vectorStore: { getRawDb: () => db, getEmbeddingDimensions: () => 0, close: () => {} } });
    runtime.core.setStorage(storage);
    await runtime.core.ensureSkillModuleWired();
    expect(runtime.core.getSkillCore()).toBeDefined();
    server = http.createServer((req, res) => { void runtime.handleRequest(req, res); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  async function closeRuntime() {
    server?.closeAllConnections();
    await new Promise<void>(resolve => server?.close(() => resolve()));
    await gateway.stop();
    db.close();
  }
  afterEach(async () => {
    await closeRuntime();
    await rm(dir, { recursive: true, force: true });
  });
  async function post(path: string, body: unknown, userKey?: string) {
    const response = await fetch(baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer runtime-test-key",
      "x-tdai-service-id": "default", ...(userKey ? { "x-tdai-user-key": userKey } : {}) }, body: JSON.stringify(body) });
    return response.json() as Promise<{ code: number; data: any; message?: string }>;
  }
  async function actor() {
    const admin = await post("/v3/internal/meta/user/init-admin", { username: "runtime-admin" });
    expect(admin.code).toBe(0);
    const userKey = admin.data.user_key ?? admin.data.default_user_key;
    const user = await post("/v3/meta/user/create", { username: "runtime-user" }, userKey);
    expect(user.code).toBe(0);
    const key = user.data.default_user_key;
    const team = await post("/v3/meta/team/create", { name: "Runtime team", owner_user_id: user.data.user_id }, key);
    expect(team.code).toBe(0);
    const agent = await post("/v3/meta/agent/create", { team_id: team.data.team_id, owner_user_id: user.data.user_id, name: "Runtime agent" }, key);
    expect(agent.code).toBe(0);
    return { key, ids: { user_id: user.data.user_id, team_id: team.data.team_id, agent_id: agent.data.agent_id, task_id: "runtime-task" } };
  }
  async function withMongoCore(visit: (core: SkillCore) => Promise<void>) {
    const mongod = await MongoMemoryServer.create();
    const client = await MongoClient.connect(mongod.getUri());
    try {
      const mongoConfig = { endpoint: mongod.getUri(), database: "runtime-skills", user: "", password: "" };
      const store = new MongoSkillStore({ pool: {} as MongoClientPool, mongoConfig });
      // Local Mongo supplies real documents; mongot search initialization is outside this fixture.
      Object.assign(store, { db: client.db(mongoConfig.database), initialized: true });
      Object.assign(runtime, { configProvider: { resolveMongo: async () => mongoConfig }, storePool: { mode: "mongodb", getSkillStore: async () => store } });
      await visit(await runtime.resolveSkillCoreForInstance("default"));
    } finally {
      Object.assign(runtime, { storePool: null, configProvider: null });
      await client.close(); await mongod.stop();
    }
  }

  it("stages automatic extraction, independently reviews, publishes, and exposes the operation through the same instance service", async () => {
    const { ids } = await actor();
    const core = runtime.core.getSkillCore()!;
    const extractor = await runtime.buildSkillExtractorForInstance(core, "default");
    const result = await extractor.extract({ ...ids, messages: [{ role: "user", content: "Save the reusable diagnosis procedure." }] });
    expect(result.operations?.[0].status).toBe("succeeded");
    const operation = await (await runtime.resolveSkillRestructureForInstance("default")).get({ ...ids, operation_id: result.operations![0].operation_id });
    const saved = await core.get({ ...ids, skill_id: operation.outputs[0].skill_id });
    expect(saved.content).toBe(rewritten);
    expect(model).toHaveBeenCalledTimes(3);
    for (const context of model.mock.contexts) expect(context).toMatchObject({ model: "skill-model", config: { maxTokens: 5678 } });
    const metadata = await runtime.ensureMetadataService("default");
    const asset = await metadata.getAssetById(saved.skill_id);
    expect(asset?.asset_id).toBe(saved.skill_id);
  });

  it("serves the actual HTTP start/status routes and executes the explicit operation through the skill worker pool", async () => {
    const { ids, key } = await actor();
    const core = runtime.core.getSkillCore()!;
    const skill = await core.create({ ...ids, name: "safe-operations", content: source });
    const response = await post("/v3/skill/restructure", { ...ids, request_id: "http-restructure", skill_id: skill.skill_id, expected_version: 1 }, key);
    expect(response.code, JSON.stringify(response)).toBe(0);
    expect(response.data.status).toBe("queued");
    const operationId = response.data.operation_id;
    let operation: SkillRestructureOperation | undefined;
    await vi.waitFor(async () => {
      const status = await post("/v3/skill/restructure/get", { ...ids, operation_id: operationId }, key);
      expect(status.code, JSON.stringify(status)).toBe(0);
      operation = status.data;
      expect(operation?.status, JSON.stringify(operation)).toBe("succeeded");
    }, { timeout: 10_000, interval: 30 });
    expect((await core.get({ ...ids, skill_id: skill.skill_id })).content).toBe(rewritten);
    expect(operation!.outputs[0]).toMatchObject({ skill_id: skill.skill_id, version: 2 });
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("publishes an independent child through HTTP with assets, search, resource reads, and independent history", async () => {
    splitCapabilities = true;
    const { ids, key } = await actor();
    const core = runtime.core.getSkillCore()!;
    const skill = await core.create({ ...ids, name: "safe-operations", content: source + frontendRule, metadata: { note: "keep user metadata" } });
    const start = await post("/v3/skill/restructure", { ...ids, request_id: "split-http", skill_id: skill.skill_id, expected_version: 1 }, key);
    expect(start.code, JSON.stringify(start)).toBe(0);
    let operation: SkillRestructureOperation | undefined;
    await vi.waitFor(async () => {
      const response = await post("/v3/skill/restructure/get", { ...ids, operation_id: start.data.operation_id }, key);
      expect(response.code).toBe(0); operation = response.data;
      expect(operation?.status, JSON.stringify(operation)).toBe("succeeded");
    }, { timeout: 10_000, interval: 30 });
    const parent = operation!.outputs.find(output => output.role === "root")!;
    const child = operation!.outputs.find(output => output.role === "child")!;
    expect(parent).toMatchObject({ skill_id: skill.skill_id, version: 2 });
    const loaded = await post("/v3/skill/get", { ...ids, skill_id: child.skill_id, include_manifest: true }, key);
    expect(loaded.code, JSON.stringify(loaded)).toBe(0);
    expect(loaded.data.content).toContain(frontendRule);
    const current = await core.get({ ...ids, skill_id: parent.skill_id });
    expect(current).toMatchObject({ skill_id: skill.skill_id, owner_agent_id: ids.agent_id, team_id: ids.team_id, name: "safe-operations" });
    expect(current.content).toContain(child.skill_id);
    expect(JSON.parse(current.metadata_json).note).toBe("keep user metadata");
    expect((await core.readFile({ ...ids, skill_id: child.skill_id, version: 1, path: "references/accessibility.md" })).content).toBe(frontendRule);
    const found = await post("/v3/skill/search", { ...ids, query: "frontend" }, key);
    expect(found.code, JSON.stringify(found)).toBe(0);
    expect(found.data.items.map((item: { skill_id: string }) => item.skill_id)).toContain(child.skill_id);
    const metadata = await runtime.ensureMetadataService("default");
    expect((await metadata.getAssetById(child.skill_id))?.asset_id).toBe(child.skill_id);
    const updated = await post("/v3/skill/update", { ...ids, skill_id: child.skill_id, expected_version: 1, content: loaded.data.content + "\nAlso verify contrast.\n" }, key);
    expect(updated.code, JSON.stringify(updated)).toBe(0);
    expect(updated.data.version).toBe(2);
    expect((await core.get({ ...ids, skill_id: child.skill_id, version: 1 })).content).not.toContain("Also verify contrast.");
    expect((await core.get({ ...ids, skill_id: parent.skill_id })).version).toBe(2);
    expect((await core.listVersions({ ...ids, skill_id: child.skill_id })).total).toBe(2);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed candidate frontmatter through the real HTTP service boundary", async () => {
    const { ids, key } = await actor();
    const response = await post("/v3/skill/restructure", { ...ids, request_id: "invalid-frontmatter",
      candidate: { name: "safe-operations", content: "Not a frontmatter document", resources: [] } }, key);
    expect(response.code, JSON.stringify(response)).toBe(42203);
    expect((await runtime.core.getSkillCore()!.list(ids)).total).toBe(0);
    expect(model).not.toHaveBeenCalled();
  });

  it("recovers a prepared publication through fresh runtime handles without model credentials", async () => {
    const { ids } = await actor();
    const core = runtime.core.getSkillCore()!;
    const skill = await core.create({ ...ids, name: "safe-operations", content: source });
    const service = await runtime.resolveSkillRestructureForInstance("default");
    await runtime.skillRestructureRecovery?.tick();
    const publish = vi.spyOn(core, "applyPackageMutation").mockRejectedValueOnce(new Error("temporary publication outage"));
    const first = await service.runCandidate({ ...ids, request_id: "recover-runtime", source: { skill_id: skill.skill_id, expected_version: 1 }, force: true,
      candidate: { name: skill.name, content: skill.content, resources: [] } });
    expect(first.status).toBe("publishing");
    publish.mockRestore();
    runtime.config.llm.apiKey = "";
    runtime.core.getResolvedSkillConfig()!.restructure!.enabled = false;
    const fresh = await runtime.resolveSkillRestructureForInstance("default");
    const recovered = await fresh.process(first.operation_id);
    expect(recovered.status).toBe("succeeded");
    expect((await core.get({ ...ids, skill_id: skill.skill_id })).version).toBe(2);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("reopens persisted skill and metadata databases and resumes a prepared operation without a model", async () => {
    const { ids, key } = await actor();
    const core = runtime.core.getSkillCore()!;
    const skill = await core.create({ ...ids, name: "safe-operations", content: source });
    const service = await runtime.resolveSkillRestructureForInstance("default");
    await runtime.skillRestructureRecovery?.tick();
    const publish = vi.spyOn(core, "applyPackageMutation").mockRejectedValueOnce(new Error("publication interrupted before shutdown"));
    const first = await service.runCandidate({ ...ids, request_id: "persisted-restart", source: { skill_id: skill.skill_id, expected_version: 1 }, force: true,
      candidate: { name: skill.name, content: skill.content, resources: [] } });
    expect(first.status).toBe("publishing");
    publish.mockRestore();
    await closeRuntime();
    await openRuntime("");
    await runtime.ensureSkillWorkerPool();
    runtime.trackSkillRecoveryInstance("default");
    await vi.waitFor(async () => {
      const response = await post("/v3/skill/restructure/get", { ...ids, operation_id: first.operation_id }, key);
      expect(response.code, JSON.stringify(response)).toBe(0);
      expect(response.data.status, JSON.stringify(response)).toBe("succeeded");
    }, { timeout: 10_000, interval: 30 });
    const recoveredCore = runtime.core.getSkillCore()!;
    expect((await recoveredCore.get({ ...ids, skill_id: skill.skill_id })).content).toBe(rewritten);
    expect((await recoveredCore.get({ ...ids, skill_id: skill.skill_id, version: 1 })).content).toBe(source);
    expect((await recoveredCore.listVersions({ ...ids, skill_id: skill.skill_id })).total).toBe(2);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("requeues durable operations after the local scheduling signal is lost", async () => {
    const { ids, key } = await actor();
    const core = runtime.core.getSkillCore()!;
    const skill = await core.create({ ...ids, name: "safe-operations", content: source });
    const service = await runtime.resolveSkillRestructureForInstance("default");
    await runtime.skillRestructureRecovery?.tick();
    const enqueue = vi.spyOn(runtime, "ensureSkillWorkerPool").mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(service.start({ ...ids, request_id: "lost-enqueue", skill_id: skill.skill_id, expected_version: 1 })).rejects.toThrow("queue unavailable");
    enqueue.mockRestore();
    await runtime.skillRestructureRecovery!.tick();
    await vi.waitFor(async () => expect((await core.get({ ...ids, skill_id: skill.skill_id })).version).toBe(2), { timeout: 10_000, interval: 30 });
    const replay = await post("/v3/skill/restructure", { ...ids, request_id: "lost-enqueue", skill_id: skill.skill_id, expected_version: 1 }, key);
    expect(replay.code, JSON.stringify(replay)).toBe(0);
    expect(replay.data.status).toBe("succeeded");
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("does not re-register a forgotten instance when a recovery resolver finishes late", async () => {
    await actor();
    const resolveMetadata = runtime.ensureMetadataService.bind(runtime);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const metadata = vi.spyOn(runtime, "ensureMetadataService").mockImplementation(async instanceId => {
      await pending;
      return resolveMetadata(instanceId);
    });
    runtime.trackSkillRecoveryInstance("default");
    await vi.waitFor(() => expect(metadata).toHaveBeenCalledTimes(1));
    const recovery = runtime.skillRestructureRecovery!;
    recovery.forget("default");
    release();
    await recovery.tick();
    await recovery.tick();
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(model).not.toHaveBeenCalled();
  });

  it("does not construct a worker pool after shutdown has begun", async () => {
    runtime.stopPromise = Promise.resolve();
    try {
      await expect(runtime.ensureSkillWorkerPool()).rejects.toMatchObject({ code: "ABORTED" });
      expect(runtime.skillWorkerPool).toBeNull();
    } finally { runtime.stopPromise = null; }
  });

  it("keeps automatic extraction disabled while allowing explicit semantic restructuring", async () => {
    const { ids, key } = await actor();
    const core = runtime.core.getSkillCore()!;
    runtime.core.getResolvedSkillConfig()!.extraction.enabled = false;
    await expect(runtime.buildSkillExtractorForInstance(core, "default")).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    const skill = await core.create({ ...ids, name: "safe-operations", content: source });
    const response = await post("/v3/skill/restructure", { ...ids, request_id: "explicit-only", skill_id: skill.skill_id, expected_version: 1 }, key);
    expect(response.code, JSON.stringify(response)).toBe(0);
    await vi.waitFor(async () => expect((await core.get({ ...ids, skill_id: skill.skill_id })).version).toBe(2), { timeout: 10_000, interval: 30 });
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("keeps disabled semantic restructuring out of legacy extraction and refuses new explicit operations", async () => {
    const { ids, key } = await actor();
    runtime.core.getResolvedSkillConfig()!.restructure!.enabled = false;
    model.mockImplementation(async (params: LLMRunParams) => {
      if (!params.tools?.skill_create) return "safe operations";
      const published = await call(params, "skill_create", { name: "safe-operations", content: source });
      expect(published.skill_id).toBeDefined(); expect(published.draft_id).toBeUndefined();
      return "Created the skill.";
    });
    const result = await (await runtime.buildSkillExtractorForInstance(runtime.core.getSkillCore()!, "default"))
      .extract({ ...ids, messages: [{ role: "user", content: "Save this procedure." }] });
    expect(result.operations).toBeUndefined();
    const saved = (await runtime.core.getSkillCore()!.list(ids)).items[0];
    expect(saved.content).toBe(source);
    const response = await post("/v3/skill/restructure", { ...ids, request_id: "disabled", skill_id: saved.skill_id, expected_version: 1 }, key);
    expect(response.code).toBe(50301);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it.each(["gateway", "embedded"])("checks quota for new %s publications without blocking committed asset repair", async mode => {
    const { ids } = await actor();
    const core = runtime.core.getSkillCore()!;
    const checkMemoryQuota = vi.fn().mockResolvedValue({ allowed: false, current: 10, limit: 10 });
    Object.assign(runtime, { quotaManager: { checkMemoryQuota, reportUsage: async () => {} } });
    const resolve = () => mode === "gateway" ? runtime.resolveSkillRestructureForInstance("default")
      : Promise.resolve(runtime.core.getSkillRestructureService()!);
    const service = await resolve();
    await runtime.skillRestructureRecovery?.tick();
    const first = await service.runCandidate({ ...ids, request_id: "quota-gate", candidate: { name: "safe-operations", content: rewritten, resources: [] } });
    expect(first.status).toBe("publishing");
    expect(first.error?.code).toBe("SKILL_QUOTA_EXCEEDED");
    expect((await core.list(ids)).total).toBe(0);
    expect(checkMemoryQuota).toHaveBeenCalledWith("default", 1);
    checkMemoryQuota.mockResolvedValue({ allowed: true });
    const metadata = await runtime.ensureMetadataService("default");
    vi.spyOn(metadata, "ensureSkillAsset").mockRejectedValueOnce(new Error("asset registration temporarily unavailable"));
    const committed = await (await resolve()).process(first.operation_id);
    expect(committed.status).toBe("publishing");
    expect((await core.list(ids)).total).toBe(1);
    expect(checkMemoryQuota).toHaveBeenCalledTimes(2);
    checkMemoryQuota.mockResolvedValue({ allowed: false, current: 10, limit: 10 });
    const repaired = await (await resolve()).process(first.operation_id);
    expect(repaired.status).toBe("succeeded");
    expect(checkMemoryQuota).toHaveBeenCalledTimes(2);
    expect((await core.listVersions({ ...ids, skill_id: repaired.outputs[0].skill_id })).total).toBe(1);
    expect(await metadata.getAssetById(repaired.outputs[0].skill_id)).not.toBeNull();
    expect(model).not.toHaveBeenCalled();
  });

  it.each(["source", "candidate"])("applies HTTP quota admission only to new %s intents", async kind => {
    const { ids, key } = await actor();
    const core = runtime.core.getSkillCore()!;
    const skill = kind === "source" ? await core.create({ ...ids, name: "safe-operations", content: source }) : undefined;
    const body = { ...ids, request_id: "http-quota", ...(skill
      ? { skill_id: skill.skill_id, expected_version: 1 }
      : { candidate: { name: "safe-operations", content: source, resources: [] } }) };
    const checkMemoryQuota = vi.fn().mockResolvedValue({ allowed: false, current: 10, limit: 10 });
    Object.assign(runtime, { quotaManager: { checkMemoryQuota, reportUsage: async () => {} } });
    const denied = await post("/v3/skill/restructure", body, key);
    expect(denied.code, JSON.stringify(denied)).toBe(4291);
    expect(model).not.toHaveBeenCalled();
    checkMemoryQuota.mockResolvedValue({ allowed: true });
    const accepted = await post("/v3/skill/restructure", body, key);
    expect(accepted.code, JSON.stringify(accepted)).toBe(0);
    await vi.waitFor(async () => {
      const status = await post("/v3/skill/restructure/get", { ...ids, operation_id: accepted.data.operation_id }, key);
      expect(status.code).toBe(0); expect(status.data.status, JSON.stringify(status)).toBe("succeeded");
    }, { timeout: 10_000, interval: 30 });
    const admissionCalls = checkMemoryQuota.mock.calls.length;
    checkMemoryQuota.mockResolvedValue({ allowed: false, current: 10, limit: 10 });
    const replay = await post("/v3/skill/restructure", body, key);
    expect(replay.code, JSON.stringify(replay)).toBe(0);
    expect(replay.data.operation_id).toBe(accepted.data.operation_id);
    expect(replay.data.status).toBe("succeeded");
    expect(checkMemoryQuota).toHaveBeenCalledTimes(admissionCalls);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("keeps remote deletion pending until asset cleanup succeeds and completes it on retry", async () => {
    const { ids } = await actor();
    await withMongoCore(async core => {
      const created = await core.create({ ...ids, name: "safe-operations", content: rewritten });
      const metadata = await runtime.ensureMetadataService("default");
      const cleanup = vi.spyOn(metadata, "deleteAssets").mockResolvedValueOnce({ deleted_ids: [], failed: [{ id: created.skill_id, reason: "temporary metadata outage" }] });
      await expect(core.delete({ ...ids, skill_id: created.skill_id })).rejects.toMatchObject({ code: "SKILL_DELETION_PENDING" });
      expect(await metadata.getAssetById(created.skill_id)).not.toBeNull();
      await core.delete({ ...ids, skill_id: created.skill_id });
      expect(await metadata.getAssetById(created.skill_id)).toBeNull();
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect((await core.list(ids)).total).toBe(0);
      expect(model).not.toHaveBeenCalled();
    });
  });

  it("finishes remote cleanup after metadata deletion succeeded but acknowledgement was lost", async () => {
    const { ids } = await actor();
    await withMongoCore(async core => {
      const created = await core.create({ ...ids, name: "safe-operations", content: rewritten });
      const metadata = await runtime.ensureMetadataService("default");
      const remove = metadata.deleteAssets.bind(metadata);
      const cleanup = vi.spyOn(metadata, "deleteAssets").mockImplementationOnce(async ids => {
        await remove(ids);
        throw new Error("metadata delete acknowledgement lost");
      });
      await expect(core.delete({ ...ids, skill_id: created.skill_id })).rejects.toMatchObject({ code: "SKILL_DELETION_PENDING" });
      expect(await metadata.getAssetById(created.skill_id)).toBeNull();
      await core.delete({ ...ids, skill_id: created.skill_id });
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(await cleanup.mock.results[1].value).toEqual({ deleted_ids: [created.skill_id], failed: [] });
      expect((await core.list(ids)).total).toBe(0);
      expect(model).not.toHaveBeenCalled();
    });
  });

  it("binds durable publication authority before ordinary remote Mongo writes", async () => {
    const { ids } = await actor();
    const mongod = await MongoMemoryServer.create();
    const client = await MongoClient.connect(mongod.getUri());
    try {
      const mongoConfig = { endpoint: mongod.getUri(), database: "runtime-skills", user: "", password: "" };
      const store = new MongoSkillStore({ pool: {} as MongoClientPool, mongoConfig });
      // The local server has no mongot; this fixture exercises real document publication, not search initialization.
      Object.assign(store, { db: client.db(mongoConfig.database), initialized: true });
      const bind = vi.spyOn(store, "setPublicationCoordinator");
      Object.assign(runtime, {
        configProvider: { resolveMongo: async () => mongoConfig },
        storePool: { mode: "mongodb", getSkillStore: async () => store },
      });
      const remote = await runtime.resolveSkillCoreForInstance("default");
      const created = await remote.create({ ...ids, name: "safe-operations", content: rewritten });
      const authority = bind.mock.calls[0][0];
      expect(await authority.getHead({ team_id: ids.team_id, skill_id: created.skill_id })).toMatchObject({ row_id: created.row_id, version: 1 });
      const fresh = await runtime.resolveSkillCoreForInstance("default");
      expect((await fresh.get({ ...ids, skill_id: created.skill_id })).content).toBe(rewritten);
      const updated = await fresh.update({ ...ids, skill_id: created.skill_id, expected_version: 1, content: rewritten + "\nVerify current health.\n" });
      expect(updated.version).toBe(2);
      await expect((await runtime.ensureMetadataService("default")).getAssetById(created.skill_id)).resolves.toMatchObject({ asset_id: created.skill_id });
      expect(model).not.toHaveBeenCalled();
    } finally {
      Object.assign(runtime, { storePool: null, configProvider: null });
      await client.close(); await mongod.stop();
    }
  });

  it("keeps embedded skill model routing bound to its original instance", async () => {
    const { ids } = await actor();
    const resolver = vi.spyOn(llmResolver, "resolveStandaloneLlmForRuntime");
    expect((runtime.core as unknown as { instanceId?: string }).instanceId).toBeUndefined();
    runtime.core.setInstanceId("unrelated-memory-tenant");
    const result = await runtime.core.getSkillExtractor()!.extract({ ...ids, messages: [{ role: "user", content: "Store the safe diagnosis workflow." }] });
    expect(result.operations?.[0].status).toBe("succeeded");
    expect(resolver).toHaveBeenCalledWith(expect.anything(), "default");
    expect(resolver.mock.calls.every(([, instanceId]) => instanceId === "default")).toBe(true);
  });

  it("binds private drafts in the embedded TdaiCore extractor too", async () => {
    const { ids } = await actor();
    const result = await runtime.core.getSkillExtractor()!.extract({ ...ids, messages: [{ role: "user", content: "Store the safe diagnosis workflow." }] });
    expect(result.operations?.[0].status).toBe("succeeded");
    expect((await runtime.core.getSkillCore()!.list(ids)).total).toBe(1);
  });
});
