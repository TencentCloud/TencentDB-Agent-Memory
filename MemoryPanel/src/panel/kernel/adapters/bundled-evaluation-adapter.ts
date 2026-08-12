import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import {
  EVALUATION_DISCLAIMER,
  EvaluationUnavailableError,
  type EvaluationDetail,
  type EvaluationListItem,
  type EvaluationListQuery,
  type EvaluationReadPort,
  type EvaluationRequestContext,
  type EvaluationUnavailableReason,
} from '../ports/evaluation-read-port.js';

const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const id = /^[A-Za-z0-9._-]{1,96}$/u;
const shaPin = /^sha256:[a-f0-9]{64}$/u;
const secretMarker = /(?:\b(?:authorization|bearer|api[_-]?key|password|secret|token|credential(?:[_-]?(?:value|id))?|access[_-]?key|private[_ -]?key|vault)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|evaluator-private|hidden[_ -]?(?:assertion|canary)|(?:^|[\/\\])\.env(?:\.|$|[\/\\]))/iu;
const token = /(?:\b(?:sk|gh[opusr]|xox[baprs]|glpat)[-_][A-Za-z0-9._-]{10,}\b|\b(?:A3T|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b)/u;
const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const phone = /(?:(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)|(?<![\dA-Za-z])(?:\+\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]){2,4}\d{3,4}(?!\d))/u;
const posixAbsolutePath = /(?<![\p{L}\p{N}_./:-])\/(?:[^\/\s"'`()\[\]{}<>]+\/)*[^\/\s"'`()\[\]{}<>]+/u;
const windowsAbsolutePath = /(?<![\p{L}\p{N}_])(?:[A-Za-z]:[\\/][^\s"'`()\[\]{}<>]+|\\\\[^\\/\s"'`()\[\]{}<>]+[\\/][^\s"'`()\[\]{}<>]+)/u;
const parentTraversal = /(?<![\p{L}\p{N}_.-])\.\.(?:[\/\\]|$)/u;
const urlQuery = /https?:\/\/[^\s?#]+\?[^\s]+/iu;

function isForbiddenText(value: string): boolean {
  return secretMarker.test(value) || token.test(value) || email.test(value) || phone.test(value)
    || posixAbsolutePath.test(value) || windowsAbsolutePath.test(value) || parentTraversal.test(value)
    || urlQuery.test(value);
}

function isValidUtcTimestamp(value: string): boolean {
  if (!utc.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === `${value.slice(0, -1)}.000Z`;
}

function containsForbiddenText(value: unknown): boolean {
  if (typeof value === 'string') return isForbiddenText(value);
  if (Array.isArray(value)) return value.some(containsForbiddenText);
  return value !== null && typeof value === 'object'
    && Object.values(value as Record<string, unknown>).some(containsForbiddenText);
}

const safeText = (max: number) => z.string().min(1).max(max).refine(
  (value) => !isForbiddenText(value),
  'forbidden display content',
);
const utcTimestamp = z.string().refine(isValidUtcTimestamp, 'invalid UTC RFC3339 timestamp');
const semanticsSchema = z.object({
  evidenceLevel: z.literal('E1'), liveAgentExecuted: z.literal(false), catxCalled: z.literal(false),
  externalAuthorityVerified: z.literal(false), e2Status: z.literal('BLOCKED'),
  runExposure: z.literal('NOT_PROVEN'), cardE1BindingHash: z.null(), disclaimer: z.literal(EVALUATION_DISCLAIMER),
}).strict();
const cardSchema = z.object({
  projectionType: z.literal('DISPLAY_ONLY'), cardId: z.string().regex(id), title: safeText(120),
  summary: safeText(600), tags: z.array(safeText(48)).max(12).refine((items) => new Set(items).size === items.length, 'duplicate tags'),
}).strict();
const armSchema = z.object({
  armId: z.enum(['K0P0', 'K0P1', 'K1P0', 'K1P1']), knowledgeVariant: z.enum(['K0', 'K1']),
  flowVariant: z.enum(['P0', 'P1']), recordedAccepted: z.boolean(), sampleCount: z.number().int().nonnegative(),
}).strict();
const evaluationSchema = z.object({
  evaluationId: z.string().regex(id), title: safeText(120), resultLabel: z.enum(['POSITIVE', 'INCONCLUSIVE', 'NEGATIVE']),
  generatedAt: utcTimestamp, sampleCount: z.number().int().nonnegative(),
  knowledgeCards: z.array(cardSchema).min(1).max(20), comparison: z.array(armSchema).length(4),
  metrics: z.array(z.object({ name: safeText(64), value: z.number().finite(), unit: safeText(32) }).strict()).max(20),
  evidenceSummaries: z.array(safeText(500)).min(1).max(20), limitations: z.array(safeText(500)).min(1).max(20),
  semantics: semanticsSchema,
}).strict();
const bundleSchema = z.object({
  schemaVersion: z.literal('1.0.0'), bundleVersion: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u),
  sourceMode: z.literal('RECORDED_FIXTURE'), tenantScope: z.literal('GLOBAL_SYNTHETIC'),
  generatedAt: utcTimestamp, evaluations: z.array(evaluationSchema).min(1).max(100),
}).strict();

interface Snapshot { bundleVersion: string; bundleSha256: string; evaluations: EvaluationDetail[] }

export interface BundledEvaluationOptions { enabled: boolean; bundlePath: string; expectedSha256: string; maxBytes: number }

function unavailable(reason: EvaluationUnavailableReason): never { throw new EvaluationUnavailableError(reason); }

async function readRegularNoSymlink(filePath: string, missingReason: EvaluationUnavailableReason, maxBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) unavailable('WHITELIST_VIOLATION');
    if (info.size > maxBytes) unavailable('WHITELIST_VIOLATION');
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) unavailable('WHITELIST_VIOLATION');
    return bytes;
  } catch (error) {
    if (error instanceof EvaluationUnavailableError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') unavailable(missingReason);
    unavailable('WHITELIST_VIOLATION');
  } finally {
    await handle?.close();
  }
  return unavailable('WHITELIST_VIOLATION');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export class BundledEvaluationAdapter implements EvaluationReadPort {
  private snapshotPromise: Promise<Snapshot> | undefined;
  constructor(private readonly options: BundledEvaluationOptions) {}

  private snapshot(): Promise<Snapshot> {
    if (!this.options.enabled) return Promise.reject(new EvaluationUnavailableError('EVALUATION_DISABLED'));
    this.snapshotPromise ??= this.load();
    return this.snapshotPromise;
  }

  private async load(): Promise<Snapshot> {
    const bundleBytes = await readRegularNoSymlink(this.options.bundlePath, 'BUNDLE_MISSING', this.options.maxBytes);
    const pin = this.options.expectedSha256;
    if (!shaPin.test(pin)) unavailable('DIGEST_PIN_MISSING');
    const digest = `sha256:${createHash('sha256').update(bundleBytes).digest('hex')}`;
    if (pin !== digest) unavailable('DIGEST_MISMATCH');
    let json: unknown;
    try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bundleBytes)); } catch { unavailable('SCHEMA_INVALID'); }
    const parsed = bundleSchema.safeParse(json);
    if (!parsed.success) unavailable(parsed.error.issues.some((issue) => issue.message === 'forbidden display content') ? 'WHITELIST_VIOLATION' : 'SCHEMA_INVALID');
    if (containsForbiddenText(parsed.data)) unavailable('WHITELIST_VIOLATION');
    const ids = parsed.data.evaluations.map((item) => item.evaluationId);
    if (new Set(ids).size !== ids.length) unavailable('SCHEMA_INVALID');
    for (const item of parsed.data.evaluations) {
      if (new Set(item.comparison.map((arm) => arm.armId)).size !== 4) unavailable('SCHEMA_INVALID');
      const expectedArms = { K0P0: ['K0', 'P0'], K0P1: ['K0', 'P1'], K1P0: ['K1', 'P0'], K1P1: ['K1', 'P1'] } as const;
      if (item.comparison.some((arm) => expectedArms[arm.armId][0] !== arm.knowledgeVariant || expectedArms[arm.armId][1] !== arm.flowVariant)) unavailable('SCHEMA_INVALID');
      if (item.comparison.reduce((total, arm) => total + arm.sampleCount, 0) !== item.sampleCount) unavailable('SCHEMA_INVALID');
    }
    const evaluations: EvaluationDetail[] = parsed.data.evaluations.map((item) => ({
      ...item, bundleVersion: parsed.data.bundleVersion, bundleSha256: digest,
      sourceMode: 'RECORDED_FIXTURE', tenantScope: 'GLOBAL_SYNTHETIC',
    }));
    return deepFreeze({ bundleVersion: parsed.data.bundleVersion, bundleSha256: digest, evaluations });
  }

  async list(_ctx: EvaluationRequestContext, query: EvaluationListQuery): Promise<EvaluationListItem[]> {
    const snapshot = await this.snapshot();
    const keyword = query.keyword?.trim().toLocaleLowerCase();
    return snapshot.evaluations
      .filter((item) => !query.resultLabel || item.resultLabel === query.resultLabel)
      .filter((item) => !keyword || [item.evaluationId, item.title, ...item.knowledgeCards.flatMap((card) => [card.title, ...card.tags])]
        .some((value) => value.toLocaleLowerCase().includes(keyword)))
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt) || left.evaluationId.localeCompare(right.evaluationId))
      .map((item) => ({
        evaluationId: item.evaluationId, title: item.title, resultLabel: item.resultLabel, generatedAt: item.generatedAt,
        sampleCount: item.sampleCount, semantics: item.semantics, bundleVersion: item.bundleVersion,
        bundleSha256: item.bundleSha256, sourceMode: item.sourceMode, tenantScope: item.tenantScope,
        cardTitles: item.knowledgeCards.map((card) => card.title),
      }));
  }

  async get(_ctx: EvaluationRequestContext, evaluationId: string): Promise<EvaluationDetail | null> {
    const snapshot = await this.snapshot();
    return snapshot.evaluations.find((item) => item.evaluationId === evaluationId) ?? null;
  }
}
