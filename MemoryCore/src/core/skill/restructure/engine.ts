import { tool } from 'ai';
import { z } from 'zod';
import { SkillRestructureError, type FrozenSkillPackageSnapshot, type RestructureBudgets, type RestructureDraft, type RestructureRunner, type RestructureStage, type ReviewedPackage, type ReviewedSkillRestructureResult, type SemanticReview, type SkillPackageSnapshot, type SkillRestructureOptions, type SourceBlock } from './types.js';
import { canonical, createSkillPackageSnapshot, DEFAULT_BUDGETS, freeze, HARD_BUDGETS, hash, isTextResource, resourceBytes, textBlocks } from './snapshot.js';
import { draftSchema, frozenDraftHash, reviewSchema, validateDraft, validateReview } from './validator.js';
import { BASELINE_REVIEW_INSTRUCTIONS, REVIEW_SYSTEM_PROMPT, REWRITE_SYSTEM_PROMPT } from './prompts.js';

export type { SkillPackageSnapshot, SkillRestructureOptions, ReviewedSkillRestructureResult, RestructureRunner } from './types.js';
export { SkillRestructureError } from './types.js';

const readSchema = z.object({ ids: z.array(z.string().min(1).max(160)).max(16) }).strict();
interface FrozenDraft {
  draft: RestructureDraft;
  packages: ReviewedPackage[];
  hash: string;
  blocks: SourceBlock[];
}
function freezeDraft(snapshot: FrozenSkillPackageSnapshot, draft: RestructureDraft, packages: ReviewedPackage[], blockBytes: number, baseline?: FrozenSkillPackageSnapshot): FrozenDraft {
  const context = baseline ? { sourceFingerprint: snapshot.sourceFingerprint, baselineFingerprint: baseline.sourceFingerprint } : undefined;
  const draftHash = frozenDraftHash(draft, context);
  // Materialized text lets the reviewer inspect actual copied resources. Binary bytes stay out of context.
  const reviewContent = canonical({ sourceFingerprint: snapshot.sourceFingerprint, ...(context ? { baselineFingerprint: context.baselineFingerprint } : {}), draft,
    packages: packages.map(p => ({ ...p, resources: p.resources.map(r => ({
      path: r.path, mime_type: r.mime_type, is_executable: r.is_executable,
      hash: hash(resourceBytes(r)), sizeBytes: resourceBytes(r).length,
      content: isTextResource(r) ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(resourceBytes(r)) : undefined,
      binary: !isTextResource(r),
    })) })),
  });
  return freeze({ draft, packages, hash: draftHash, blocks: textBlocks(`draft-${draftHash}.json`, reviewContent, blockBytes) });
}

/** Pure orchestration over immutable bytes; never reads storage or publishes anything. */
export async function restructureSkillPackage(input: SkillPackageSnapshot, options: SkillRestructureOptions): Promise<ReviewedSkillRestructureResult> {
  let stage: RestructureStage = 'snapshot';
  let round = 0, calls = 0, steps = 0, sourceReadBytes = 0, outputBytes = 0, retries = 0, reservedIterations = 0;
  const budgets: RestructureBudgets = { ...DEFAULT_BUDGETS, ...options.budgets };
  for (const key of Object.keys(HARD_BUDGETS) as (keyof RestructureBudgets)[]) {
    const min = key === 'maxRetries' || key === 'maxRepairRounds' ? 0 : key === 'blockBytes' ? 4 : 1;
    if (!Number.isInteger(budgets[key]) || budgets[key] < min || budgets[key] > HARD_BUDGETS[key]) throw new SkillRestructureError('BUDGET_EXCEEDED', `Invalid or excessive budget: ${key}`, stage);
  }
  const started = Date.now(); const deadline = started + budgets.deadlineMs;
  const controller = new AbortController();
  let closed = false;
  let terminal: SkillRestructureError | undefined;
  const abort = () => {
    terminal ??= new SkillRestructureError('ABORTED', 'Skill restructuring cancelled', stage);
    controller.abort(terminal);
  };
  options.abortSignal?.addEventListener('abort', abort, { once: true });
  if (options.abortSignal?.aborted) abort();
  const timer = setTimeout(() => {
    terminal ??= new SkillRestructureError('BUDGET_EXCEEDED', 'Total restructuring deadline exceeded', stage);
    controller.abort(terminal);
  }, budgets.deadlineMs);
  function check() {
    if (terminal) throw terminal;
    if (closed) throw new SkillRestructureError('ABORTED', 'This restructuring invocation has ended', stage);
    if (Date.now() >= deadline) {
      terminal = new SkillRestructureError('BUDGET_EXCEEDED', 'Total restructuring deadline exceeded', stage);
      controller.abort(terminal); throw terminal;
    }
  }
  function budget(condition: boolean, message: string) {
    check();
    if (!condition) {
      terminal = new SkillRestructureError('BUDGET_EXCEEDED', message, stage);
      controller.abort(terminal); throw terminal;
    }
  }
  function spendOutput(value: unknown) {
    outputBytes += Buffer.byteLength(canonical(value));
    budget(outputBytes <= budgets.maxOutputBytes, 'Total model output bytes exceeded');
  }
  function checkedTool<S extends z.ZodType>(description: string, schema: S, action: (args: z.output<S>) => unknown) {
    return tool({ description, inputSchema: schema, execute: async args => {
      check(); steps++; budget(steps <= budgets.maxSteps, 'Total tool steps exceeded');
      spendOutput(args);
      try {
        // Explicit parse also protects direct execute callers and custom runners, not only AI SDK.
        let parsed: z.output<S>;
        try { parsed = schema.parse(args); }
        catch (error) { throw new SkillRestructureError(stage === 'review' ? 'INVALID_REVIEW' : 'INVALID_DRAFT', 'Tool arguments failed runtime schema validation', stage, error instanceof z.ZodError ? error.issues : undefined); }
        const result = action(parsed); check(); return result;
      } finally {
        // Persist before exposing either a source/draft result or a recoverable tool error.
        await progress(stage);
      }
    } });
  }
  function readBlocks(blocks: SourceBlock[], ids: string[], coverage: Set<string>) {
    const selected = ids.map(id => {
      const block = blocks.find(b => b.id === id);
      if (!block) throw new SkillRestructureError(stage === 'review' ? 'INVALID_REVIEW' : 'INVALID_DRAFT', `Unknown block: ${id}`, stage);
      return block;
    });
    for (const block of selected) {
      if (block.kind === 'binary') continue;
      sourceReadBytes += block.sizeBytes;
    }
    budget(sourceReadBytes <= budgets.maxSourceReadBytes, 'Total source/draft read bytes exceeded');
    for (const block of selected) if (block.kind === 'text') coverage.add(block.id);
    return { blocks: selected };
  }
  let snapshot: FrozenSkillPackageSnapshot;
  let baseline: FrozenSkillPackageSnapshot | undefined;
  let frozen: FrozenDraft | undefined;
  let progressQueue = Promise.resolve();
  async function progress(next: RestructureStage) {
    check(); stage = next;
    const event = { stage, round, calls, steps: Math.max(steps, reservedIterations), sourceReadBytes, outputBytes, sourceFingerprint: snapshot?.sourceFingerprint, ...(baseline ? { baselineFingerprint: baseline.sourceFingerprint } : {}), frozenDraftHash: frozen?.hash };
    // Parallel model tool calls must not persist cumulative counters out of order.
    const persistence = progressQueue.then(async () => {
      check();
      try { await options.onProgress?.(event); }
      catch (error) {
        terminal ??= new SkillRestructureError('PROGRESS_FAILED', 'Unable to persist restructuring progress', stage, { cause: error instanceof Error ? error.message : String(error) });
        controller.abort(terminal); throw terminal;
      }
      check();
    });
    progressQueue = persistence.catch(() => {});
    await persistence;
    check();
  }
  function sourceTool(coverage: Set<string>) {
    return checkedTool('Read complete immutable source blocks by IDs; empty ids returns metadata/index only.', readSchema, ({ ids }) => ids.length ? readBlocks(snapshot.blocks, ids, coverage) : {
      sourceFingerprint: snapshot.sourceFingerprint, name: snapshot.name,
      manifest: snapshot.manifest,
      blocks: snapshot.blocks.map(({ content: _content, ...block }) => block),
    });
  }
  function baselineTool(coverage: Set<string>) {
    return checkedTool('Read the immutable ORIGINAL package before the candidate proposal. This is separate preservation context, not mandatory final resource copies. Empty ids returns its index.', readSchema, ({ ids }) => ids.length ? readBlocks(baseline!.blocks, ids, coverage) : {
      baselineFingerprint: baseline!.sourceFingerprint, name: baseline!.name, manifest: baseline!.manifest,
      blocks: baseline!.blocks.map(({ content: _content, ...block }) => block),
    });
  }
  function draftTool(coverage: Set<string>) {
    return checkedTool('Read immutable private draft blocks. Empty ids returns the index, not coverage.', readSchema, ({ ids }) => {
      if (!frozen) {
        if (ids.length) throw new SkillRestructureError('INVALID_DRAFT', 'No private draft exists yet', stage);
        return { blocks: [] };
      }
      return ids.length ? readBlocks(frozen.blocks, ids, coverage) : {
        draftHash: frozen.hash,
        ...(baseline ? { baselineFingerprint: baseline.sourceFingerprint } : {}),
        sourceIds: snapshot.blocks.filter(b => b.kind === 'text').map(b => b.id),
        blocks: frozen.blocks.map(({ content: _content, ...block }) => block),
      };
    });
  }
  async function invoke<T>(runner: RestructureRunner, systemPrompt: string, prompt: string, build: () => { tools: Record<string, unknown>; result: () => T | undefined }): Promise<T> {
    for (;;) {
      check(); budget(calls < budgets.maxCalls, 'Total runner calls exceeded');
      // Reserve each invocation's maximum LLM iterations as well as counting actual tool executes.
      const iterations = Math.min(64, Math.floor((budgets.maxSteps - reservedIterations) / Math.max(2, budgets.maxCalls - calls)));
      budget(iterations > 0, 'Total runner iterations exceeded');
      reservedIterations += iterations; calls++;
      await progress(stage);
      const invocation = build();
      let active = true;
      // Custom runners may retain tools: revoke this context when run ends or retries.
      const guardedTools = Object.fromEntries(Object.entries(invocation.tools).map(([name, value]) => {
        const t = value as { execute: (...args: unknown[]) => Promise<unknown> };
        return [name, { ...t, execute: (...args: unknown[]) => {
          if (!active) return Promise.reject(new SkillRestructureError('ABORTED', 'Runner context is closed', stage));
          return t.execute(...args);
        } }];
      }));
      try {
        const text = await runner.run({ prompt, systemPrompt, tools: guardedTools, enableTools: true,
          maxIterations: iterations, maxTokens: budgets.maxTokensPerCall, taskId: `${options.taskId}/restructure/${stage}/${round}/${calls}`,
          timeoutMs: Math.max(1, deadline - Date.now()), signal: controller.signal, abortSignal: controller.signal,
          traceName: `skill-restructure-${stage}`, tags: ['skill-restructure', stage],
        });
        check(); spendOutput(text);
        await progress(stage);
        const result = invocation.result();
        if (!result) throw new SkillRestructureError('NOT_SUBMITTED', `Explicit ${stage === 'review' ? 'submit_review' : 'submit_draft'} is required`, stage);
        return result;
      } catch (error) {
        check();
        if (error instanceof SkillRestructureError) throw error;
        if (retries >= budgets.maxRetries) throw new SkillRestructureError('RUNNER_FAILED', 'Injected runner failed', stage, { cause: error instanceof Error ? error.message : String(error) });
        retries++;
      } finally { active = false; }
    }
  }
  async function work(): Promise<ReviewedSkillRestructureResult> {
    check();
    snapshot = createSkillPackageSnapshot(input, budgets);
    if (options.baselineSnapshot) {
      const original = createSkillPackageSnapshot(options.baselineSnapshot, budgets);
      baseline = freeze({ ...original, blocks: original.blocks.map(block => ({ ...block, id: `baseline-${block.id}` })) });
    }
    const allBlocks = [...snapshot.blocks, ...(baseline?.blocks ?? [])];
    const textSize = allBlocks.reduce((sum, b) => sum + (b.kind === 'text' ? b.sizeBytes : 0), 0);
    budget(textSize <= budgets.maxSourceBytes && allBlocks.length <= 8192, 'Combined candidate and baseline exceed the bounded source budget');
    budget(textSize * 2 <= budgets.maxSourceReadBytes, 'Budget cannot cover writer and independent review of complete candidate and baseline');
    await progress('snapshot');
    let previousReview: SemanticReview | undefined;
    for (round = 0; round <= budgets.maxRepairRounds; round++) {
      await progress(round === 0 ? 'rewrite' : 'repair');
      const written = await invoke(options.runner, REWRITE_SYSTEM_PROMPT + (baseline ? `\n\n${BASELINE_REVIEW_INSTRUCTIONS}` : ''),
        canonical({ task: 'Understand and semantically restructure the complete fixed skill package. Call read_source with ids:[] first.', sourceFingerprint: snapshot.sourceFingerprint,
          ...(baseline ? { baselineFingerprint: baseline.sourceFingerprint, originalPackageTool: 'read_baseline' } : {}),
          repair: previousReview, budget: { maxReadBytes: budgets.maxSourceReadBytes - sourceReadBytes, maxOutputBytes: budgets.maxOutputBytes - outputBytes },
        }), () => {
          const coverage = new Set<string>(); const baselineCoverage = new Set<string>(); let submitted: { draft: RestructureDraft; packages: ReviewedPackage[] } | undefined;
          return { tools: {
            read_source: sourceTool(coverage), read_draft: draftTool(new Set()),
            ...(baseline ? { read_baseline: baselineTool(baselineCoverage) } : {}),
            submit_draft: checkedTool('Explicitly submit the complete final private proposal once; not a publish operation.', draftSchema, candidate => {
              if (submitted) throw new SkillRestructureError('INVALID_DRAFT', 'Submitted draft is immutable', stage);
              submitted = validateDraft(snapshot, candidate, coverage, baseline, baselineCoverage);
              freeze(submitted); return { accepted: true };
            }),
          }, result: () => submitted && { ...submitted, coverage, baselineCoverage } };
        });
      await progress('validate');
      frozen = freezeDraft(snapshot, written.draft, written.packages, budgets.blockBytes, baseline);
      await progress('review');
      const reviewed = await invoke(options.reviewerRunner ?? options.runner, REVIEW_SYSTEM_PROMPT + (baseline ? `\n\n${BASELINE_REVIEW_INSTRUCTIONS}` : ''),
        canonical({ task: 'Independently compare ALL candidate source, original baseline (when present), and frozen draft blocks; submit_review explicitly. Begin by listing the read indexes.', sourceFingerprint: snapshot.sourceFingerprint, ...(baseline ? { baselineFingerprint: baseline.sourceFingerprint, originalPackageTool: 'read_baseline' } : {}), frozenDraftHash: frozen.hash }), () => {
          const coverage = new Set<string>(); const baselineCoverage = new Set<string>(); const draftCoverage = new Set<string>(); let submitted: SemanticReview | undefined;
          return { tools: {
            read_source: sourceTool(coverage), read_draft: draftTool(draftCoverage),
            ...(baseline ? { read_baseline: baselineTool(baselineCoverage) } : {}),
            submit_review: checkedTool('Submit an independent pass/fail/insufficient verdict with evidence against this exact frozen draft.', reviewSchema, candidate => {
              if (submitted) throw new SkillRestructureError('INVALID_REVIEW', 'Review already submitted', stage);
              const unread = snapshot.blocks.filter(b => b.kind === 'text' && !coverage.has(b.id));
              if (unread.length) throw new SkillRestructureError('SOURCE_UNREAD', 'Independent reviewer must read all source text', stage, { missing: unread.map(b => b.id) });
              const unreadBaseline = baseline?.blocks.filter(b => b.kind === 'text' && !baselineCoverage.has(b.id)) ?? [];
              if (unreadBaseline.length) throw new SkillRestructureError('SOURCE_UNREAD', 'Independent reviewer must read the complete ORIGINAL baseline, not only the candidate', stage, { missing: unreadBaseline.map(b => b.id), context: 'baseline' });
              const unreadDraft = frozen!.blocks.filter(b => !draftCoverage.has(b.id));
              if (unreadDraft.length) throw new SkillRestructureError('DRAFT_UNREAD', 'Independent reviewer must read complete frozen draft', stage, { missing: unreadDraft.map(b => b.id) });
              submitted = freeze(validateReview(snapshot, frozen!.draft, frozen!.packages, candidate, frozen!.hash, baseline));
              return { accepted: true };
            }),
          }, result: () => submitted && { review: submitted, coverage, baselineCoverage, draftCoverage } };
        });
      if (reviewed.review.verdict === 'pass') {
        const common = { sourceFingerprint: snapshot.sourceFingerprint, ...(baseline ? { baselineFingerprint: baseline.sourceFingerprint } : {}), frozenDraftHash: frozen.hash, rationale: frozen.draft.rationale,
          review: reviewed.review, ruleMappings: frozen.draft.ruleMappings, dispositions: frozen.draft.dispositions,
          coverage: { writer: [...written.coverage], reviewer: [...reviewed.coverage], draft: [...reviewed.draftCoverage], ...(baseline ? { baselineWriter: [...written.baselineCoverage], baselineReviewer: [...reviewed.baselineCoverage] } : {}) },
        };
        await progress('complete');
        return freeze(frozen.draft.kind === 'keep' ? { kind: 'keep', ...common } : { kind: 'restructured', ...common, root: frozen.packages[0], children: frozen.packages.slice(1) });
      }
      previousReview = reviewed.review;
    }
    throw new SkillRestructureError('REVIEW_REJECTED', 'Independent review rejected the proposal or had insufficient evidence', 'review', previousReview);
  }
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const handler = () => reject(terminal ?? new SkillRestructureError('ABORTED', 'Restructuring cancelled', stage));
    controller.signal.addEventListener('abort', handler, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener('abort', handler);
    if (controller.signal.aborted) handler();
  });
  try { return await Promise.race([work(), aborted]); }
  finally {
    closed = true; clearTimeout(timer); removeAbortListener();
    options.abortSignal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
