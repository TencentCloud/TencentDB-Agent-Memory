import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SkillCore, SkillCoreError } from "./skill-core.js";
import { parseSkillFile, validateSkillFile } from "./skill-format.js";
import { guessSkillResourceMime, type SkillResourcePayload } from "./skill-resource-store.js";
import type { AtomicSkillStateStore } from "./skill-state-store.js";
import type { IdFields, Skill } from "./types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { restructureSkillPackage } from "./restructure/engine.js";
import { canonical, createSkillPackageSnapshot, DEFAULT_BUDGETS, hash, isTextResource, resourceBytes } from "./restructure/snapshot.js";
import type { JsonValue, RestructureProgress, RestructureRunner, ReviewedPackage, ReviewedSkillRestructureResult, SkillPackageSnapshot } from "./restructure/types.js";
import { DEFAULT_SKILL_RESTRUCTURE_CONFIG, type SkillCandidateSubmission, type SkillDraftBatch, type SkillDraftBatchInput, type SkillDraftPublisher, type SkillPackageCandidate, type SkillRestructureConfig, type SkillRestructureOperation, type SkillRestructureOutput, type StartSkillRestructureInput } from "./skill-restructure-types.js";

const terminal = new Set(["succeeded", "unchanged", "rejected", "conflict", "failed"]);
const actorSchema = z.object({ user_id: z.string(), team_id: z.string(), agent_id: z.string(), task_id: z.string() });
type Actor = z.infer<typeof actorSchema>;
const costSchema = z.object({ calls: z.number(), steps: z.number(), sourceReadBytes: z.number(), outputBytes: z.number() });
const outputSchema = z.object({ key: z.string(), skill_id: z.string(), version: z.number(), name: z.string(), role: z.enum(["root", "child"]), reused: z.boolean() });
const operationSchema = z.object({
  operation_id: z.string(), status: z.enum(["queued", "running", "prepared", "publishing", "succeeded", "unchanged", "rejected", "conflict", "failed"]),
  actor: actorSchema, request_hash: z.string(), source_skill_id: z.string(), source_version: z.number(), input_key: z.string(), input_hash: z.string(),
  created_at_ms: z.number(), updated_at_ms: z.number(), attempts: z.number(), outputs: z.array(outputSchema), cost: costSchema,
  started_at_ms: z.number().optional(), lease_token: z.string().optional(), lease_until_ms: z.number().optional(), next_attempt_at_ms: z.number().optional(),
  plan_key: z.string().optional(), plan_hash: z.string().optional(), rationale: z.string().optional(), review_summary: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).strict();
type StoredOperation = z.infer<typeof operationSchema>;
interface StoredInput { snapshot: SkillPackageSnapshot; baselineSnapshot?: SkillPackageSnapshot; source?: { skill_id: string; expected_version: number }; base_hash?: string; changed: boolean; force: boolean; }
interface PublicationTarget extends SkillPackageCandidate { key: string; skill_id: string; expected_version: number; mutation_id: string; action: "create" | "update" | "reuse"; package_hash: string; }
interface PublicationPlan { root: PublicationTarget; children: PublicationTarget[]; rationale: string; review_summary: string; semantic: boolean; source_hash: string; }

export interface SkillRestructureServiceOptions {
  core: SkillCore;
  storage: StorageAdapter;
  state: AtomicSkillStateStore;
  namespace: string;
  runner: RestructureRunner | (() => Promise<RestructureRunner>);
  ensureAsset: (skill: Skill) => Promise<void>;
  /** Host quota preflight for NEW package mutations only, never receipt/asset recovery. */
  beforePublish?: () => Promise<void>;
  enqueue?: (operation: SkillRestructureOperation, actor: Required<IdFields>) => Promise<void>;
  config?: Partial<SkillRestructureConfig>;
  engine?: typeof restructureSkillPackage;
  now?: () => number;
}

export class SkillRestructureServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); this.name = "SkillRestructureServiceError"; }
}

/** Models only see snapshots; this service is the sole bridge from reviewed drafts to live packages. */
export class SkillRestructureService implements SkillDraftPublisher {
  private readonly prefix: string;
  private readonly config: SkillRestructureConfig;
  private readonly now: () => number;
  private readonly engine: typeof restructureSkillPackage;
  /** Resume bounded scans beyond leased/not-yet-due work on the next recovery tick. */
  private recoveryAfter?: string;
  constructor(private readonly options: SkillRestructureServiceOptions) {
    if (!options.namespace) throw new Error("Skill restructuring requires an instance namespace");
    this.prefix = `skill-restructure/${hash(options.namespace)}`;
    this.config = { ...DEFAULT_SKILL_RESTRUCTURE_CONFIG, ...options.config, budgets: { ...DEFAULT_SKILL_RESTRUCTURE_CONFIG.budgets, ...options.config?.budgets } };
    if (typeof this.config.enabled !== "boolean") throw new Error("Invalid restructure configuration: enabled");
    for (const key of ["bodyReviewChars", "packageTextReviewBytes", "resourceReviewCount", "leaseMs", "maxAttempts"] as const) {
      if (!Number.isSafeInteger(this.config[key]) || this.config[key] < 1) throw new Error(`Invalid restructure configuration: ${key}`);
    }
    if (!Number.isSafeInteger(this.config.retryDelayMs) || this.config.retryDelayMs < 0) throw new Error("Invalid restructure retry delay");
    this.now = options.now ?? Date.now;
    this.engine = options.engine ?? restructureSkillPackage;
  }

  async start(input: StartSkillRestructureInput, beforeSubmit?: () => Promise<void>): Promise<SkillRestructureOperation> {
    this.enabled();
    const actor = normalizeActor(input);
    const requestHash = hash(canonical({ source: { skill_id: input.skill_id, expected_version: input.expected_version }, reason: input.reason ?? "", policy: this.config.policyVersion }));
    const id = this.operationId(input.request_id, actor);
    const existing = await this.existing(id, requestHash);
    if (existing) { await this.enqueue(existing); return view(existing); }
    await beforeSubmit?.();
    const source = await this.options.core.readPackage({ ...actor, skill_id: input.skill_id, expected_version: input.expected_version });
    const candidate = { name: source.skill.name, content: source.skill.content, resources: source.resources, metadata: metadataOf(source.skill) };
    const stored = this.makeInput(id, actor, candidate, input, source, true);
    const operation = await this.createOperation(id, requestHash, actor, stored);
    await this.enqueue(operation);
    return view(operation);
  }

  async submitCandidate(input: SkillCandidateSubmission, beforeSubmit?: () => Promise<void>): Promise<SkillRestructureOperation> {
    const operation = await this.submitCandidateRecord(input, beforeSubmit);
    await this.enqueue(operation);
    return view(operation);
  }

  async runCandidate(input: SkillCandidateSubmission, signal?: AbortSignal): Promise<SkillRestructureOperation> {
    if (signal?.aborted) throw new SkillRestructureServiceError("ABORTED", "Extraction was cancelled", true);
    const operation = await this.submitCandidateRecord(input);
    return this.process(operation.operation_id, signal);
  }

  async get(input: IdFields & { operation_id: string }): Promise<SkillRestructureOperation> {
    const actor = normalizeActor(input);
    const operation = await this.readOperation(input.operation_id);
    if (!operation || !sameActor(operation.value.actor, actor)) throw new SkillRestructureServiceError("SKILL_OPERATION_NOT_FOUND", "Operation not found");
    return view(operation.value);
  }

  async loadDraftBatch(input: SkillDraftBatchInput): Promise<SkillDraftBatch | null> {
    const row = await this.options.state.read(this.batchKey(input));
    if (!row) return null;
    const data = z.object({ input_hash: z.string(), key: z.string(), hash: z.string() }).parse(row.value);
    if (data.input_hash !== input.input_hash) throw new SkillRestructureServiceError("SKILL_MUTATION_CONFLICT", "Extraction request key was reused with different original input");
    return this.readBlob<SkillDraftBatch>(data.key, data.hash);
  }

  async freezeDraftBatch(input: SkillDraftBatchInput & SkillDraftBatch): Promise<SkillDraftBatch> {
    const existing = await this.loadDraftBatch(input);
    if (existing) return existing;
    const blob = await this.writeBlob(`batches/${hash(this.batchKey(input))}`, { candidates: input.candidates });
    await this.options.state.create(this.batchKey(input), { input_hash: input.input_hash, ...blob });
    const frozen = await this.loadDraftBatch(input);
    if (!frozen) throw new SkillRestructureServiceError("SKILL_PUBLICATION_UNKNOWN", "Frozen extraction batch was not durable", true);
    return frozen;
  }

  async requeuePending(options: { limit?: number; after?: string } = {}): Promise<{ enqueued: number; next?: string }> {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Recovery limit must be 1..1000");
    const page = await this.options.state.list(`${this.prefix}/pending/`, { limit, after: options.after });
    let enqueued = 0;
    for (const entry of page.items) {
      const { operation_id } = z.object({ operation_id: z.string() }).parse(entry.value);
      const row = await this.readOperation(operation_id);
      if (!row || terminal.has(row.value.status)) {
        await this.options.state.remove(entry.key, entry.revision);
      } else if (this.options.enqueue && (row.value.next_attempt_at_ms ?? 0) <= this.now() && (row.value.lease_until_ms ?? 0) <= this.now()
        && (this.config.enabled || (row.value.plan_key && row.value.plan_hash))) {
        await this.enqueue(row.value);
        enqueued++;
      }
    }
    return { enqueued, ...(page.next ? { next: page.next } : {}) };
  }

  async recover(signal?: AbortSignal, limit = 50): Promise<SkillRestructureOperation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Recovery limit must be 1..1000");
    const results: SkillRestructureOperation[] = [];
    // Bound both attempts and catalogue reads; terminal/busy markers do not consume an attempt.
    let scanned = 0;
    while (!signal?.aborted && results.length < limit && scanned < 1000) {
      const page = await this.options.state.list(`${this.prefix}/pending/`, { limit: Math.min(limit, 1000 - scanned), after: this.recoveryAfter });
      for (const entry of page.items) {
        if (signal?.aborted) return results;
        const data = z.object({ operation_id: z.string() }).parse(entry.value);
        const row = await this.readOperation(data.operation_id);
        if (!row || terminal.has(row.value.status)) {
          await this.removePending(data.operation_id);
        } else if ((row.value.next_attempt_at_ms ?? 0) <= this.now() && (row.value.lease_until_ms ?? 0) <= this.now()
          && (this.config.enabled || (row.value.plan_key && row.value.plan_hash))) {
          results.push(await this.process(data.operation_id, signal));
        }
        this.recoveryAfter = entry.key;
        scanned++;
        if (results.length >= limit) return results;
      }
      if (!page.next) { this.recoveryAfter = undefined; break; }
    }
    return results;
  }

  async process(operationId: string, signal?: AbortSignal): Promise<SkillRestructureOperation> {
    let row = await this.readOperation(operationId);
    if (!row) throw new SkillRestructureServiceError("SKILL_OPERATION_NOT_FOUND", "Operation not found");
    if (terminal.has(row.value.status)) { await this.removePending(operationId); return view(row.value); }
    if (!row.value.plan_key || !row.value.plan_hash) this.enabled();
    if (signal?.aborted || (row.value.next_attempt_at_ms ?? 0) > this.now() || (row.value.lease_until_ms ?? 0) > this.now()) return view(row.value);
    const token = randomUUID();
    const started = row.value.started_at_ms ?? this.now();
    const claimed = { ...row.value, started_at_ms: started, attempts: row.value.attempts + 1, lease_token: token,
      lease_until_ms: this.now() + this.config.leaseMs, updated_at_ms: this.now(), status: row.value.plan_key ? row.value.status : "running" as const };
    if (!await this.options.state.compareAndSet(this.operationKey(operationId), row.revision, json(claimed))) return view((await this.readOperation(operationId))!.value);
    let operation = operationSchema.parse(json(claimed));
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new Error("Operation cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = this.updateOwned(operationId, token, current => ({ ...current, lease_until_ms: this.now() + this.config.leaseMs }))
        .then(() => {}).catch(error => controller.abort(error)).finally(() => { renewal = undefined; });
    }, Math.max(50, Math.floor(this.config.leaseMs / 3)));
    heartbeat.unref();
    try {
      const input = await this.readBlob<StoredInput>(operation.input_key, operation.input_hash);
      let plan: PublicationPlan;
      if (operation.plan_key && operation.plan_hash) {
        // A reviewed plan may already be committed. Model budgets cannot prevent receipt/asset recovery.
        plan = await this.readBlob<PublicationPlan>(operation.plan_key, operation.plan_hash);
      } else {
        if (operation.attempts > this.config.maxAttempts) throw new SkillRestructureServiceError("BUDGET_EXCEEDED", "Operation attempt budget exhausted");
        const totalBudgets = { ...DEFAULT_BUDGETS, ...this.config.budgets };
        const remainingMs = totalBudgets.deadlineMs - (this.now() - started);
        if (remainingMs <= 0) throw new SkillRestructureServiceError("BUDGET_EXCEEDED", "Operation deadline exhausted");
        await this.assertBaseCurrent(input, operation.actor);
        if (input.source && input.changed && !input.baselineSnapshot) throw new SkillRestructureServiceError("REVIEW_REJECTED", "This legacy unprepared update has no frozen original baseline; resubmit rather than guessing lost rules");
        // Unchanged/manual restructuring already has the original as its source; changed proposals need both views.
        const baselineSnapshot = input.changed ? input.baselineSnapshot : undefined;
        const reviewNeeded = input.force || shouldReviewPackage(input.snapshot, this.config) || Boolean(input.baselineSnapshot && shouldReviewPackage(input.baselineSnapshot, this.config));
        const cacheKey = this.diagnosticKey(input.snapshot, baselineSnapshot);
        const cached = !input.force ? await this.options.state.read(cacheKey) : null;
        if (!input.changed && (!reviewNeeded || cached)) {
          operation = await this.updateOwned(operationId, token, current => ({ ...current, status: "unchanged", rationale: cached ? "This exact package was already reviewed under the current policy." : "The unchanged package is below semantic-review thresholds." }));
          return view(operation);
        }
        let reviewed: ReviewedSkillRestructureResult | undefined;
        if (reviewNeeded && !cached) {
          const remaining = { ...totalBudgets, deadlineMs: remainingMs, maxCalls: totalBudgets.maxCalls - operation.cost.calls,
            maxSteps: totalBudgets.maxSteps - operation.cost.steps, maxSourceReadBytes: totalBudgets.maxSourceReadBytes - operation.cost.sourceReadBytes,
            maxOutputBytes: totalBudgets.maxOutputBytes - operation.cost.outputBytes };
          const runner = typeof this.options.runner === "function" ? await this.options.runner() : this.options.runner;
          const previousCost = { ...operation.cost };
          reviewed = await this.engine(input.snapshot, { runner, baselineSnapshot, taskId: operationId, abortSignal: controller.signal, budgets: remaining,
            onProgress: async progress => {
              operation = await this.updateOwned(operationId, token, current => ({ ...current, cost: accumulatedCost(previousCost, progress) }));
            } });
          const expected = createSkillPackageSnapshot(input.snapshot, remaining).sourceFingerprint;
          const expectedBaseline = baselineSnapshot ? createSkillPackageSnapshot(baselineSnapshot, remaining).sourceFingerprint : undefined;
          if (reviewed.sourceFingerprint !== expected || reviewed.baselineFingerprint !== expectedBaseline || reviewed.review.baselineFingerprint !== expectedBaseline || reviewed.review.verdict !== "pass" || reviewed.review.draftHash !== reviewed.frozenDraftHash || !Object.values(reviewed.review.checks).every(Boolean)) {
            throw new SkillRestructureServiceError("REVIEW_REJECTED", "The final review does not approve this exact source and draft");
          }
          await this.writeBlob(`operations/${operationId}/reviews`, reviewed);
          if (reviewed.kind === "keep" && !input.changed) {
            await this.options.state.create(cacheKey, { operation_id: operationId, package_hash: packageHash(input.snapshot), policy: this.config.policyVersion });
            operation = await this.updateOwned(operationId, token, current => ({ ...current, status: "unchanged", rationale: reviewed!.rationale, review_summary: reviewed!.review.summary }));
            return view(operation);
          }
        }
        await this.assertBaseCurrent(input, operation.actor);
        plan = await this.preparePlan(operation, input, reviewed);
        const blob = await this.writeBlob(`operations/${operationId}/plans`, plan);
        operation = await this.updateOwned(operationId, token, current => ({ ...current, status: "prepared", plan_key: blob.key, plan_hash: blob.hash, rationale: plan.rationale, review_summary: plan.review_summary }));
      }
      if (controller.signal.aborted) throw new SkillRestructureServiceError("ABORTED", "Operation cancelled before publication", true);
      operation = await this.updateOwned(operationId, token, current => ({ ...current, status: "publishing" }));
      const rootReceipt = await this.options.core.lookupPackageMutation({ ...operation.actor, skill_id: plan.root.skill_id, mutation_id: plan.root.mutation_id });
      const recordReceipt = async (target: PublicationTarget, receipt: Skill) => {
        if (receiptHash(receipt) !== target.package_hash) throw new SkillRestructureServiceError("SKILL_MUTATION_CONFLICT", "Committed receipt differs from the frozen publication target");
        const output: SkillRestructureOutput = { key: target.key, skill_id: receipt.skill_id, version: receipt.version, name: receipt.name,
          role: target.key === "root" ? "root" : "child", reused: target.action === "reuse" };
        operation = await this.updateOwned(operationId, token, current => ({ ...current, outputs: [...current.outputs.filter(item => item.key !== target.key), output] }));
      };
      // Persist commit evidence before a failing child/asset lookup can obscure that the root is live.
      if (rootReceipt) await recordReceipt(plan.root, rootReceipt);
      else await this.assertBaseCurrent(input, operation.actor);
      const childReceipts = new Map<string, Skill>();
      for (const target of [...plan.children, plan.root]) {
        if (controller.signal.aborted) throw new SkillRestructureServiceError("ABORTED", "Operation cancelled during publication", true);
        await this.owned(operationId, token);
        let receipt: Skill | null = target.key === "root" && rootReceipt ? rootReceipt : target.action === "reuse"
          ? await this.options.core.get({ ...operation.actor, skill_id: target.skill_id, version: target.expected_version })
          : await this.options.core.lookupPackageMutation({ ...operation.actor, skill_id: target.skill_id, mutation_id: target.mutation_id });
        if (!receipt) {
          if (rootReceipt) throw new SkillRestructureServiceError("SKILL_MUTATION_CONFLICT", "Source is already committed but a child receipt is unavailable; publication needs reconciliation, not recreation");
          const assertRootDependencies = async () => {
            if (target.key !== "root") return;
            // All child asset awaits have finished. Do not publish an entry point to a changed/deleted dependency.
            for (const child of plan.children) {
              const committed = childReceipts.get(child.key)!;
              const live = await this.options.core.readPackage({ ...operation.actor, skill_id: child.skill_id, expected_version: committed.version });
              if (packageHash({ name: live.skill.name, content: live.skill.content, resources: live.resources, metadata: metadataOf(live.skill) }) !== child.package_hash) {
                throw new SkillRestructureServiceError("SKILL_VERSION_STALE", "A child changed before the source entry point could be published");
              }
            }
            await this.assertBaseCurrent(input, operation.actor);
          };
          await assertRootDependencies();
          await this.options.beforePublish?.();
          // Quota checks can await remote state; fence any dependency changes across that await too.
          if (this.options.beforePublish) await assertRootDependencies();
          if (controller.signal.aborted) throw new SkillRestructureServiceError("ABORTED", "Operation cancelled before package mutation", true);
          await this.owned(operationId, token);
          const fields = { ...operation.actor, name: target.name, content: target.content, resources: target.resources, metadata: target.metadata, skill_id: target.skill_id, mutation_id: target.mutation_id };
          receipt = target.action === "create" ? await this.options.core.createPackageVersion(fields)
            : await this.options.core.applyPackageMutation({ ...fields, expected_version: target.expected_version });
        }
        await recordReceipt(target, receipt);
        if (target.key !== "root") childReceipts.set(target.key, receipt);
        const live = await this.options.core.get({ ...operation.actor, skill_id: target.skill_id });
        if (!rootReceipt && target.key !== "root" && live.version !== receipt.version) throw new SkillRestructureServiceError("SKILL_VERSION_STALE", "A target changed before the source entry point could be published");
        // Recovery repairs the current asset, never overwrites a later human edit with historical metadata.
        await this.options.ensureAsset(live);
      }
      operation = await this.updateOwned(operationId, token, current => ({ ...current, status: "succeeded", error: undefined }));
      if (plan.semantic) {
        for (const target of [...plan.children, plan.root]) {
          await this.options.state.create(this.diagnosticKey({ ...input.snapshot, skill_id: target.skill_id, name: target.name, content: target.content, resources: target.resources, metadata: target.metadata as Record<string, JsonValue> }),
            { operation_id: operationId, package_hash: target.package_hash, policy: this.config.policyVersion });
        }
      }
      return view(operation);
    } catch (error) {
      const detail = errorDetail(error);
      try {
        operation = await this.updateOwned(operationId, token, current => {
          const conflict = ["SKILL_VERSION_STALE", "SKILL_ID_COLLISION", "SKILL_NAME_DUPLICATE", "SKILL_MUTATION_CONFLICT", "SKILL_NOT_FOUND", "SKILL_NOT_OWNER", "SKILL_PROTECTED", "RESOURCE_INTEGRITY_ERROR"].includes(detail.code);
          const rejected = ["REVIEW_REJECTED", "INVALID_DRAFT", "INVALID_REVIEW", "INVALID_SNAPSHOT", "SOURCE_UNREAD", "DRAFT_UNREAD", "NOT_SUBMITTED", "BUDGET_EXCEEDED", "RESOURCE_TOO_LARGE", "SKILL_FRONTMATTER_INVALID"].includes(detail.code);
          const status = conflict ? "conflict" : current.plan_key ? "publishing" : rejected ? "rejected" : current.attempts >= this.config.maxAttempts ? "failed" : "queued";
          return { ...current, status, error: detail, next_attempt_at_ms: this.now() + this.config.retryDelayMs };
        });
        return view(operation);
      } catch { throw new SkillRestructureServiceError("SKILL_PUBLICATION_UNKNOWN", "Operation state must be recovered after lease or storage failure", true); }
    } finally {
      clearInterval(heartbeat); await renewal;
      signal?.removeEventListener("abort", abort);
      await this.updateOwned(operationId, token, current => ({ ...current, lease_token: undefined, lease_until_ms: undefined })).catch(() => {});
      const current = await this.readOperation(operationId).catch(() => null);
      if (current && terminal.has(current.value.status)) await this.removePending(operationId);
    }
  }

  private async submitCandidateRecord(input: SkillCandidateSubmission, beforeSubmit?: () => Promise<void>): Promise<StoredOperation> {
    this.enabled();
    const actor = normalizeActor(input), id = this.operationId(input.request_id, actor);
    const requestHash = hash(canonical({ candidate: input.candidate, source: input.source, force: input.force ?? false, policy: this.config.policyVersion }));
    const existing = await this.existing(id, requestHash);
    if (existing) return existing;
    await beforeSubmit?.();
    const base = input.source ? await this.options.core.readPackage({ ...actor, ...input.source }) : undefined;
    const stored = this.makeInput(id, actor, input.candidate, input.source, base, input.force ?? false);
    return this.createOperation(id, requestHash, actor, stored);
  }

  private makeInput(id: string, actor: Actor, candidate: SkillPackageCandidate, source: { skill_id: string; expected_version: number } | undefined, base: { skill: Skill; resources: SkillResourcePayload[] } | undefined, force: boolean): StoredInput {
    let file: ReturnType<typeof parseSkillFile>;
    try {
      file = parseSkillFile(candidate.content);
      validateSkillFile({ ...file, body: "" });
    } catch (error) {
      throw new SkillCoreError("SKILL_FRONTMATTER_INVALID", error instanceof Error ? error.message : "Invalid candidate frontmatter");
    }
    if (file.frontmatter.name !== candidate.name) throw new SkillCoreError("INVALID_FRONTMATTER", "Candidate name does not match its frontmatter");
    const resources = normalizeResources(candidate.resources);
    const metadata = mergeCandidateMetadata(base ? metadataOf(base.skill) : {}, candidate.metadata);
    if (base) {
      assertNotProtected(base.skill.content, metadataOf(base.skill));
      assertGuardFieldsUnchanged(base.skill.content, candidate.content);
    }
    assertNotProtected(candidate.content, metadata);
    const snapshot: SkillPackageSnapshot = { skill_id: source?.skill_id ?? stableSkillId(id, "root"), version: source?.expected_version ?? 0,
      name: candidate.name, content: candidate.content, resources,
      identity: base ? { user_id: base.skill.user_id, team_id: base.skill.team_id, agent_id: base.skill.owner_agent_id, task_id: base.skill.task_id } : actor,
      metadata: json(metadata) as Record<string, JsonValue>, manifest: resources.map(resource => ({ path: resource.path, size_bytes: resourceBytes(resource).length, mime_type: resource.mime_type!, is_executable: resource.is_executable! })) };
    const baseHash = base ? packageHash({ name: base.skill.name, content: base.skill.content, resources: base.resources, metadata: metadataOf(base.skill) }) : undefined;
    const baselineSnapshot: SkillPackageSnapshot | undefined = base ? {
      skill_id: base.skill.skill_id, version: base.skill.version, name: base.skill.name, content: base.skill.content,
      resources: normalizeResources(base.resources), manifest: base.skill.manifest.map(entry => ({ ...entry })),
      identity: { user_id: base.skill.user_id, team_id: base.skill.team_id, agent_id: base.skill.owner_agent_id, task_id: base.skill.task_id },
      metadata: json(metadataOf(base.skill)) as Record<string, JsonValue>,
    } : undefined;
    return { snapshot, ...(baselineSnapshot ? { baselineSnapshot } : {}), source, base_hash: baseHash, changed: !base || packageHash(snapshot) !== baseHash, force };
  }

  private async createOperation(id: string, requestHash: string, actor: Actor, input: StoredInput): Promise<StoredOperation> {
    const blob = await this.writeBlob(`operations/${id}/inputs`, input);
    const operation: StoredOperation = { operation_id: id, actor, request_hash: requestHash, status: "queued", source_skill_id: input.snapshot.skill_id,
      source_version: input.snapshot.version, input_key: blob.key, input_hash: blob.hash, created_at_ms: this.now(), updated_at_ms: this.now(), attempts: 0,
      outputs: [], cost: { calls: 0, steps: 0, sourceReadBytes: 0, outputBytes: 0 } };
    await this.options.state.create(this.operationKey(id), json(operation));
    const existing = await this.existing(id, requestHash);
    if (!existing) throw new SkillRestructureServiceError("SKILL_PUBLICATION_UNKNOWN", "Operation was not persisted", true);
    if (!terminal.has(existing.status)) await this.options.state.create(this.pendingKey(id), { operation_id: id });
    return existing;
  }

  private async preparePlan(operation: StoredOperation, input: StoredInput, reviewed?: ReviewedSkillRestructureResult): Promise<PublicationPlan> {
    const rootPackage: ReviewedPackage = reviewed?.kind === "restructured" ? reviewed.root : { key: "root", name: input.snapshot.name, content: input.snapshot.content,
      resources: input.snapshot.resources, resourcePlans: input.snapshot.resources.map(r => ({ kind: "copy_from", path: r.path, sourcePath: r.path })), children: [], identity: input.snapshot.identity, metadata: input.snapshot.metadata };
    const childPackages = reviewed?.kind === "restructured" ? reviewed.children : [];
    const ids = new Map<string, string>([["root", input.snapshot.skill_id]]);
    const reuse = new Map<string, { skill: Skill; resources: SkillResourcePayload[] }>();
    for (const child of childPackages) {
      let found: Skill | undefined;
      for (let offset = 0; offset < 4096; offset += 1000) {
        const page = await this.options.core.list({ ...operation.actor, filters: { owner_agent_id: operation.actor.agent_id, name_prefix: child.name }, pagination: { limit: 1000, offset } });
        found = page.items.find(item => item.name === child.name);
        if (found || offset + page.items.length >= page.total) break;
        if (offset + 1000 >= 4096) throw new SkillRestructureServiceError("BUDGET_EXCEEDED", "Name conflict scan exceeded its bounded catalogue budget");
      }
      if (found) reuse.set(child.key, await this.options.core.readPackage({ ...operation.actor, skill_id: found.skill_id, expected_version: found.version }));
      ids.set(child.key, found?.skill_id ?? stableSkillId(operation.operation_id, child.key));
    }
    const targets = [rootPackage, ...childPackages].map(pkg => {
      const replace = (text: string) => text.replace(/\{\{skill:([^}]+)\}\}/g, (literal, key: string) => pkg.children.includes(key) ? ids.get(key) ?? literal : literal);
      const resources = normalizeResources(pkg.resources.map(resource => {
        const plan = pkg.resourcePlans.find(item => item.path === resource.path);
        return plan?.kind === "write" && resource.encoding === "utf-8" ? { ...resource, content: replace(resource.content) } : resource;
      }));
      const content = replace(pkg.content);
      const reused = reuse.get(pkg.key);
      if (reused && packageContentHash({ name: pkg.name, content, resources }) !== packageContentHash({ name: reused.skill.name, content: reused.skill.content, resources: reused.resources })) {
        throw new SkillRestructureServiceError("SKILL_NAME_DUPLICATE", `Existing capability '${pkg.name}' differs from the proposed child; it cannot be silently overwritten or duplicated`);
      }
      const userMetadata = reused ? metadataOf(reused.skill) : pkg.metadata;
      const old = userMetadata.__skill_restructure;
      if (old !== undefined && (!old || typeof old !== "object" || (old as { schema_version?: unknown }).schema_version !== 1)) throw new SkillRestructureServiceError("SKILL_MUTATION_CONFLICT", "User metadata conflicts with the reserved restructuring namespace");
      const metadata = reused ? userMetadata : { ...userMetadata, __skill_restructure: { schema_version: 1, operation_id: operation.operation_id,
        source_skill_id: input.snapshot.skill_id, source_version: input.snapshot.version, key: pkg.key,
        children: pkg.children.map(key => { const child = childPackages.find(p => p.key === key)!; return { skill_id: ids.get(key), name: child.name, description: parseSkillFile(child.content).frontmatter.description }; }),
        ...(old && typeof old === "object" && "operation_id" in old ? { previous_operation_id: old.operation_id } : {}) } };
      this.validateTarget({ name: pkg.name, content, resources, metadata });
      const target: PublicationTarget = { key: pkg.key, skill_id: ids.get(pkg.key)!, name: pkg.name, content, resources, metadata,
        action: reused ? "reuse" : pkg.key === "root" && input.source ? "update" : "create", expected_version: reused?.skill.version ?? (pkg.key === "root" ? input.snapshot.version : 0),
        mutation_id: `${operation.operation_id}/${pkg.key}`, package_hash: packageHash({ name: pkg.name, content, resources, metadata }) };
      return target;
    });
    const byKey = new Map(targets.map(target => [target.key, target]));
    const ordered: PublicationTarget[] = [], visited = new Set<string>();
    const visit = (pkg: ReviewedPackage) => {
      if (visited.has(pkg.key)) return; visited.add(pkg.key);
      for (const key of pkg.children) visit(childPackages.find(child => child.key === key)!);
      if (pkg.key !== "root") ordered.push(byKey.get(pkg.key)!);
    };
    visit(rootPackage);
    return { root: targets[0], children: ordered, semantic: !!reviewed, source_hash: packageHash(input.snapshot),
      rationale: reviewed?.rationale ?? "Publish the exact extraction draft; semantic restructuring was not needed.",
      review_summary: reviewed?.review.summary ?? "No semantic rewrite: normal package validation applies." };
  }

  private validateTarget(target: SkillPackageCandidate): void {
    const file = parseSkillFile(target.content); validateSkillFile(file);
    if (file.frontmatter.name !== target.name) throw new SkillCoreError("INVALID_FRONTMATTER", "Resolved target name changed");
    assertNotProtected(target.content, target.metadata ?? {});
    const limits = this.options.core.getPackageLimits();
    const seen = new Set<string>(); let total = 0;
    for (const resource of target.resources) {
      if (!resource.path || resource.path.startsWith("/") || /[\\\0]/.test(resource.path) || resource.path.split("/").some(segment => !segment || segment === "." || segment === "..") || seen.has(resource.path)) throw new SkillCoreError("INVALID_PATH", "Invalid complete resource set");
      seen.add(resource.path); const size = resourceBytes(resource).length; total += size;
      if (size > limits.resourceBytes) throw new SkillCoreError("RESOURCE_TOO_LARGE", "A reviewed resource exceeds the configured storage limit");
    }
    if (total > limits.totalResourceBytes) throw new SkillCoreError("RESOURCE_TOO_LARGE", "The reviewed resource set exceeds the configured storage limit");
  }

  private async assertBaseCurrent(input: StoredInput, actor: Actor): Promise<void> {
    if (!input.source) return;
    const current = await this.options.core.readPackage({ ...actor, ...input.source });
    if (packageHash({ name: current.skill.name, content: current.skill.content, resources: current.resources, metadata: metadataOf(current.skill) }) !== input.base_hash) throw new SkillRestructureServiceError("SKILL_VERSION_STALE", "Source bytes changed after the snapshot");
  }
  private async removePending(id: string): Promise<void> {
    const pending = await this.options.state.read(this.pendingKey(id));
    if (pending) await this.options.state.remove(this.pendingKey(id), pending.revision);
  }
  private async enqueue(operation: StoredOperation) { if (!terminal.has(operation.status)) await this.options.enqueue?.(view(operation), operation.actor); }
  private async existing(id: string, requestHash: string): Promise<StoredOperation | null> {
    const existing = await this.readOperation(id);
    if (existing && existing.value.request_hash !== requestHash) throw new SkillRestructureServiceError("SKILL_MUTATION_CONFLICT", "Request id was reused with a different package");
    return existing?.value ?? null;
  }
  private async owned(id: string, token: string) {
    const row = await this.readOperation(id);
    if (!row || row.value.lease_token !== token || (row.value.lease_until_ms ?? 0) <= this.now()) throw new SkillRestructureServiceError("SKILL_OPERATION_LEASE_LOST", "Operation lease is no longer owned", true);
    return row;
  }
  private async updateOwned(id: string, token: string, update: (operation: StoredOperation) => StoredOperation): Promise<StoredOperation> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const current = await this.owned(id, token);
      const next = operationSchema.parse(json({ ...update(current.value), updated_at_ms: this.now() }));
      if (await this.options.state.compareAndSet(this.operationKey(id), current.revision, json(next))) return next;
    }
    throw new SkillRestructureServiceError("SKILL_PUBLICATION_BUSY", "Operation state remained contended", true);
  }
  private async readOperation(id: string) {
    if (!/^sro-[a-f0-9]{32}$/.test(id)) throw new SkillRestructureServiceError("SKILL_OPERATION_NOT_FOUND", "Invalid operation id");
    const row = await this.options.state.read(this.operationKey(id));
    return row ? { revision: row.revision, value: operationSchema.parse(row.value) } : null;
  }
  private async writeBlob(path: string, value: unknown): Promise<{ key: string; hash: string }> {
    const content = canonical(value), digest = hash(content);
    // Some adapters truncate on write. Each attempt owns a fresh immutable blob; CAS chooses its pointer.
    const key = `${this.prefix}/${path}/${digest}-${randomUUID()}.json`;
    await this.options.storage.writeFile(key, content);
    return { key, hash: digest };
  }
  private async readBlob<T>(key: string, expectedHash: string): Promise<T> {
    if (!key.startsWith(`${this.prefix}/`) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new SkillRestructureServiceError("RESOURCE_INTEGRITY_ERROR", "Invalid operation artifact reference");
    const text = await this.options.storage.readFile(key);
    if (text === null || hash(text) !== expectedHash) throw new SkillRestructureServiceError("RESOURCE_INTEGRITY_ERROR", "Operation artifact is missing or changed");
    return JSON.parse(text) as T;
  }
  private diagnosticKey(snapshot: Pick<SkillPackageSnapshot, "skill_id" | "name" | "content" | "resources" | "metadata">, baseline?: SkillPackageSnapshot) {
    // A coherent candidate is not proof that it preserves a different original package.
    const originalHash = baseline ? hash(canonical(baseline)) : null;
    return `${this.prefix}/diagnostic/${hash(canonical(["baseline-aware-v1", snapshot.skill_id, packageHash(snapshot), originalHash, this.config.policyVersion]))}`;
  }
  private operationKey(id: string) { return `${this.prefix}/operation/${id}`; }
  private pendingKey(id: string) { return `${this.prefix}/pending/${id}`; }
  private operationId(requestId: string, actor: Actor) { validRequestId(requestId); return `sro-${hash(canonical([this.prefix, actor.user_id, actor.team_id, actor.agent_id, requestId])).slice(0, 32)}`; }
  private batchKey(input: SkillDraftBatchInput) { validRequestId(input.request_id); const actor = normalizeActor(input); return `${this.prefix}/batch/${hash(canonical([actor.user_id, actor.team_id, actor.agent_id, input.request_id]))}`; }
  private enabled() { if (!this.config.enabled) throw new SkillRestructureServiceError("SKILL_RESTRUCTURE_DISABLED", "Semantic restructuring is disabled"); }
}

export function shouldReviewPackage(snapshot: Pick<SkillPackageSnapshot, "content" | "resources">, config: Pick<SkillRestructureConfig, "bodyReviewChars" | "packageTextReviewBytes" | "resourceReviewCount"> = DEFAULT_SKILL_RESTRUCTURE_CONFIG): boolean {
  const body = parseSkillFile(snapshot.content).body;
  const textBytes = Buffer.byteLength(snapshot.content) + snapshot.resources.reduce((sum, resource) => sum + (isTextResource(resource) ? resourceBytes(resource).length : 0), 0);
  return body.length > config.bodyReviewChars || textBytes > config.packageTextReviewBytes || snapshot.resources.length > config.resourceReviewCount;
}
function normalizeActor(input: IdFields): Actor {
  const actor: Actor = { user_id: "default", team_id: "default", agent_id: "default", task_id: "default" };
  for (const key of Object.keys(actor) as (keyof Actor)[]) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new SkillRestructureServiceError("SKILL_MUTATION_CONFLICT", "Invalid operation identity");
    }
    actor[key] = value;
  }
  return actor;
}
function sameActor(a: Actor, b: Actor) { return a.user_id === b.user_id && a.team_id === b.team_id && a.agent_id === b.agent_id; }
function validRequestId(id: string) { if (typeof id !== "string" || !id.trim() || id.length > 256 || /[\0-\x1f]/.test(id)) throw new SkillRestructureServiceError("SKILL_MUTATION_CONFLICT", "A bounded stable request_id is required"); }
function stableSkillId(operation: string, key: string) { return `skl-${hash(canonical([operation, key])).slice(0, 24)}`; }
function json(value: unknown): unknown { return JSON.parse(canonical(value)); }
function metadataOf(skill: Skill): Record<string, unknown> { const metadata: unknown = JSON.parse(skill.metadata_json); if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new SkillRestructureServiceError("SKILL_MUTATION_CONFLICT", "Invalid source metadata"); return metadata as Record<string, unknown>; }
function normalizeResources(resources: SkillResourcePayload[]): SkillResourcePayload[] { return resources.map(resource => ({ ...resource, mime_type: resource.mime_type ?? guessSkillResourceMime(resource.path), is_executable: resource.is_executable ?? false })).sort((a, b) => a.path.localeCompare(b.path)); }
function packageContentHash(pkg: Pick<SkillPackageCandidate, "name" | "content" | "resources">): string { return hash(canonical({ name: pkg.name, content: pkg.content, resources: normalizeResources(pkg.resources).map(resource => ({ path: resource.path, hash: hash(resourceBytes(resource)), mime_type: resource.mime_type, is_executable: resource.is_executable })) })); }
function userMetadata(metadata: Record<string, unknown> | undefined) { const result = { ...metadata }; delete result.__skill_restructure; return result; }
function packageHash(pkg: SkillPackageCandidate): string { return hash(canonical({ content_hash: packageContentHash(pkg), metadata: userMetadata(pkg.metadata) })); }
function receiptHash(skill: Skill): string { return hash(canonical({ content_hash: hash(canonical({ name: skill.name, content: skill.content, resources: [...skill.manifest].sort((a, b) => a.path.localeCompare(b.path)).map(entry => ({ path: entry.path, hash: entry.content_sha256, mime_type: entry.mime_type, is_executable: entry.is_executable })) })), metadata: userMetadata(metadataOf(skill)) })); }
function view(operation: StoredOperation): SkillRestructureOperation { const { operation_id, status, source_skill_id, source_version, created_at_ms, updated_at_ms, attempts, outputs, rationale, review_summary, error } = operation; return { operation_id, status, source_skill_id, source_version, created_at_ms, updated_at_ms, attempts, outputs, ...(rationale ? { rationale } : {}), ...(review_summary ? { review_summary } : {}), ...(error ? { error } : {}) }; }
function errorDetail(error: unknown): { code: string; message: string } { const value = error as { code?: unknown; message?: unknown }; return { code: typeof value?.code === "string" ? value.code : "INTERNAL", message: String(value?.message ?? error).slice(0, 2000) }; }
function accumulatedCost(previous: StoredOperation["cost"], progress: RestructureProgress): StoredOperation["cost"] { return { calls: previous.calls + progress.calls, steps: previous.steps + progress.steps, sourceReadBytes: previous.sourceReadBytes + progress.sourceReadBytes, outputBytes: previous.outputBytes + progress.outputBytes }; }
function rawFrontmatter(content: string): Record<string, unknown> {
  const match = content.replace(/\r\n?/g, "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new SkillCoreError("INVALID_FRONTMATTER", "Invalid frontmatter fence");
  const value: unknown = parseYaml(match[1]);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SkillCoreError("INVALID_FRONTMATTER", "Invalid frontmatter");
  return value as Record<string, unknown>;
}
function assertNotProtected(content: string, metadata: Record<string, unknown>) {
  const frontmatter = rawFrontmatter(content);
  for (const value of [frontmatter, frontmatter.metadata, frontmatter.source, metadata, metadata.source]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const flags = value as Record<string, unknown>;
    if (flags.protected === true || flags.pinned === true || flags.external_managed === true || flags.managed_by === "external" || flags.source === "external" || flags.source === "external-managed") {
      throw new SkillCoreError("SKILL_PROTECTED", "Protected packages cannot be automatically restructured");
    }
  }
}
function assertGuardFieldsUnchanged(before: string, after: string) {
  const original = rawFrontmatter(before), candidate = rawFrontmatter(after);
  // Match the engine's root contract, but compare against the live base BEFORE the candidate becomes its source.
  const protectedField = (key: string) => /^(?:protected|pinned|allowed[-_]?tools|denied[-_]?tools|permissions?|disable-model-invocation|user-invocable|hooks|context|agent)$/i.test(key);
  for (const [key, value] of Object.entries(original)) {
    if (key === "description" || key === "resources") continue;
    if (!Object.hasOwn(candidate, key) || canonical(value) !== canonical(candidate[key])) throw new SkillCoreError("SKILL_PROTECTED", `Extraction cannot change original frontmatter field: ${key}`);
  }
  for (const key of Object.keys(candidate)) {
    if (protectedField(key) && !Object.hasOwn(original, key)) throw new SkillCoreError("SKILL_PROTECTED", `Extraction cannot introduce a permission/protection field: ${key}`);
  }
}
function mergeCandidateMetadata(original: Record<string, unknown>, candidate: Record<string, unknown> | undefined): Record<string, unknown> {
  if (candidate === undefined) return original;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new SkillCoreError("SKILL_MUTATION_CONFLICT", "Candidate metadata must be an object");
  for (const [key, value] of Object.entries(candidate)) {
    if (Object.hasOwn(original, key) && canonical(value) !== canonical(original[key])) throw new SkillCoreError("SKILL_PROTECTED", `Extraction cannot overwrite original metadata: ${key}`);
  }
  return { ...original, ...candidate };
}
