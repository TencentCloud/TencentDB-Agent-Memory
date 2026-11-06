import type { SkillResourcePayload } from '../skill-resource-store.js';
import type { SkillManifestEntry } from '../types.js';
export type { SkillResourcePayload } from '../skill-resource-store.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface SnapshotManifestEntry extends SkillManifestEntry {
  /** Optional for legacy manifests; verified against decoded bytes when present. */
  content_sha256?: string;
}

/** All resources must be read by the caller from one fixed version, including attributes. */
export interface SkillPackageSnapshot {
  skill_id: string;
  /** 0 with a draft:<operationId> identity denotes an unpublished candidate. */
  version: number;
  name: string;
  content: string;
  identity: Record<string, JsonValue>;
  metadata: Record<string, JsonValue>;
  manifest: SnapshotManifestEntry[];
  resources: SkillResourcePayload[];
}
export interface SourceBlock {
  id: string;
  path: string;
  kind: 'text' | 'binary';
  hash: string;
  sizeBytes: number;
  /** UTF-8 byte offset, never a partial code point. Binary has no content. */
  offset: number;
  content?: string;
}
export interface FrozenSkillPackageSnapshot extends SkillPackageSnapshot {
  sourceFingerprint: string;
  blocks: SourceBlock[];
  resourceHashes: Record<string, string>;
}
export interface RestructureRunner {
  run(params: {
    prompt: string;
    systemPrompt?: string;
    tools?: Record<string, unknown>;
    enableTools?: boolean;
    maxIterations?: number;
    maxTokens?: number;
    taskId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Both spellings are supplied for injected runners. */
    abortSignal?: AbortSignal;
    traceName?: string;
    tags?: string[];
  }): Promise<string>;
}
export interface DraftTarget {
  packageKey: string;
  /** SKILL.md or an owned resource path; not an arbitrary workspace filename. */
  path: string;
  /** Required for rule mappings and text transformation evidence. Literal excerpt. */
  quote?: string;
}
export type DraftResource =
  | { kind: 'copy_from'; path: string; sourcePath: string }
  | { kind: 'write'; path: string; content: string; encoding: 'utf-8'; mime_type?: string; is_executable?: boolean };
export interface DraftPackage {
  /** root or a class-level child slug, never a real skill ID. */
  key: string;
  name: string;
  content: string;
  resources: DraftResource[];
  /** Explicit dependency/navigation edges. Content uses {{skill:KEY}} markers. */
  children: string[];
}
export interface SourceDisposition {
  sourceId: string;
  action: 'preserve' | 'rewrite' | 'remove';
  reason: string;
  targets: DraftTarget[];
}
export interface RuleMapping {
  rule: string;
  critical: boolean;
  /** Defaults to package scope owned by root for backwards compatibility. */
  scope?: 'package' | 'global';
  ownerPackageKey?: string;
  /** Global scope: applicable child keys; omitted means all children. Root always applies. */
  appliesTo?: string[];
  sourceIds: string[];
  targets: DraftTarget[];
}
export interface SemanticTransformation {
  kind: 'deduplicate' | 'remove_narrative' | 'synthesize' | 'split_capability';
  sourceIds: string[];
  before: string;
  explanation: string;
  after: DraftTarget;
}
export interface RestructureDraft {
  kind: 'keep' | 'restructure';
  rationale: string;
  /** keep has no packages; dispositions map to the original root. */
  root?: DraftPackage;
  children: DraftPackage[];
  dispositions: SourceDisposition[];
  ruleMappings: RuleMapping[];
  transformations: SemanticTransformation[];
}
export interface SemanticReview {
  verdict: 'pass' | 'fail' | 'insufficient';
  draftHash: string;
  /** Required when reviewing a candidate against a fixed prior package. */
  baselineFingerprint?: string;
  summary: string;
  checks: {
    preservation: boolean;
    organization: boolean;
    independence: boolean;
    grounding: boolean;
    injectionSafety: boolean;
  };
  evidence: { sourceIds: string[]; target?: DraftTarget; explanation: string }[];
}
export interface ReviewedPackage {
  key: string;
  name: string;
  content: string;
  resources: SkillResourcePayload[];
  resourcePlans: DraftResource[];
  children: string[];
  /** Root is inherited unchanged. Children inherit ownership, never user metadata. */
  identity: Record<string, JsonValue>;
  metadata: Record<string, JsonValue>;
}
interface ReviewedCommon {
  /** Fingerprint of the proposed candidate, not a substitute for its prior package. */
  sourceFingerprint: string;
  baselineFingerprint?: string;
  frozenDraftHash: string;
  rationale: string;
  review: SemanticReview;
  ruleMappings: RuleMapping[];
  dispositions: SourceDisposition[];
  /** Final round coverage; not model assertions. */
  coverage: { writer: string[]; reviewer: string[]; draft: string[]; baselineWriter?: string[]; baselineReviewer?: string[] };
}
export type ReviewedSkillRestructureResult =
  | (ReviewedCommon & { kind: 'keep' })
  | (ReviewedCommon & { kind: 'restructured'; root: ReviewedPackage; children: ReviewedPackage[] });
export interface RestructureBudgets {
  blockBytes: number;
  maxSourceBytes: number;
  maxSourceReadBytes: number;
  maxOutputBytes: number;
  maxSteps: number;
  maxCalls: number;
  maxTokensPerCall: number;
  deadlineMs: number;
  maxRetries: number;
  maxRepairRounds: number;
}
export type RestructureStage = 'snapshot' | 'rewrite' | 'validate' | 'review' | 'repair' | 'complete';
export interface RestructureProgress {
  stage: RestructureStage;
  round: number;
  calls: number;
  /** High-water usage: max(actual tool executes, reserved runner iterations), safe for crash recovery. */
  steps: number;
  sourceReadBytes: number;
  outputBytes: number;
  sourceFingerprint?: string;
  baselineFingerprint?: string;
  frozenDraftHash?: string;
}
export interface SkillRestructureOptions {
  runner: RestructureRunner;
  /** Immutable original package for preservation review. Its resources are context, not mandatory final copies. */
  baselineSnapshot?: SkillPackageSnapshot;
  /** Separate invocation and context even when this is omitted. */
  reviewerRunner?: RestructureRunner;
  taskId: string;
  abortSignal?: AbortSignal;
  budgets?: Partial<RestructureBudgets>;
  onProgress?: (progress: RestructureProgress) => void | Promise<void>;
}
export type RestructureErrorCode = 'INVALID_SNAPSHOT' | 'INVALID_DRAFT' | 'INVALID_REVIEW' | 'SOURCE_UNREAD' | 'DRAFT_UNREAD' | 'BUDGET_EXCEEDED' | 'ABORTED' | 'NOT_SUBMITTED' | 'REVIEW_REJECTED' | 'RUNNER_FAILED' | 'PROGRESS_FAILED';
export class SkillRestructureError extends Error {
  constructor(public readonly code: RestructureErrorCode, message: string, public readonly stage: RestructureStage = 'validate', public readonly details?: unknown) {
    super(message);
    this.name = 'SkillRestructureError';
  }
}
