import { describe, expect, it } from 'vitest';
import { restructureSkillPackage } from './engine.js';
import { createSkillPackageSnapshot } from './snapshot.js';
import type { RestructureDraft, RestructureRunner, SkillPackageSnapshot } from './types.js';

const APPROVAL = 'Require explicit approval before production changes.';
const TLS = 'Always verify TLS certificates; never disable verification.';
function snapshot(body = APPROVAL): SkillPackageSnapshot {
  return { skill_id: 'skl-source', version: 3, name: 'network-operations', content: `---\nname: network-operations\ndescription: Diagnose services safely.\n---\n# Network operations\n${body}\n`, identity: { user_id: 'author', team_id: 'team', agent_id: 'agent' }, metadata: {}, resources: [], manifest: [] };
}
type Params = Parameters<RestructureRunner['run']>[0];
async function execute(params: Params, name: string, args: unknown): Promise<any> {
  return (params.tools![name] as { execute(input: unknown, options: unknown): Promise<unknown> }).execute(args, { toolCallId: 'baseline-test', messages: [] });
}
async function read(params: Params, tool: string) {
  const index = await execute(params, tool, { ids: [] });
  const content: Array<{ id: string; path: string; content: string }> = [];
  for (const block of index.blocks) if (block.kind === 'text') content.push(...(await execute(params, tool, { ids: [block.id] })).blocks);
  return { index, content, text: content.filter(b => b.path === 'SKILL.md').map(b => b.content).join('') };
}
function policy(options: { skipWriterBaseline?: boolean; skipReviewerBaseline?: boolean; staleFingerprint?: string; repair?: boolean; omitBaselineEvidence?: boolean } = {}): RestructureRunner {
  return { run: async params => {
    const source = await read(params, 'read_source');
    const baseline = params.tools?.read_baseline && !(params.tools.submit_draft ? options.skipWriterBaseline : options.skipReviewerBaseline)
      ? await read(params, 'read_baseline') : undefined;
    const sourceIds = source.content.filter(b => b.path === 'SKILL.md').map(b => b.id);
    const target = { packageKey: 'root', path: 'SKILL.md', quote: APPROVAL };
    if (params.tools?.submit_draft) {
      const draft: RestructureDraft = { kind: 'keep', rationale: 'Keep the candidate only if the independent review also approves the original-package comparison.', children: [],
        dispositions: source.index.blocks.map((b: { id: string; path: string }) => ({ sourceId: b.id, action: 'preserve', reason: 'Keep the proposed package unchanged.', targets: [{ packageKey: 'root', path: b.path }] })),
        ruleMappings: [{ rule: APPROVAL, critical: true, sourceIds, targets: [target] }], transformations: [] };
      if (options.repair && baseline?.text.includes(TLS) && !source.text.includes(TLS)) {
        const baselineIds = baseline.content.filter(b => b.path === 'SKILL.md').map(b => b.id);
        const restored = { packageKey: 'root', path: 'SKILL.md', quote: TLS };
        draft.kind = 'restructure'; draft.root = { key: 'root', name: source.index.name, content: `${source.text}\n${TLS}\n`, children: [], resources: source.index.manifest.map((r: { path: string }) => ({ kind: 'copy_from', path: r.path, sourcePath: r.path })) };
        for (const d of draft.dispositions) if (d.targets[0].path === 'SKILL.md') d.action = 'rewrite';
        draft.ruleMappings.push({ rule: TLS, critical: true, sourceIds: baselineIds, targets: [restored] });
        draft.transformations.push({ kind: 'synthesize', sourceIds: baselineIds, before: TLS, after: restored, explanation: 'Restore the omitted prior safety constraint verbatim, not an invented instruction.' });
      }
      await execute(params, 'submit_draft', draft);
    } else {
      const draft = await read(params, 'read_draft');
      const materialized = JSON.parse(draft.content.map(b => b.content).join(''));
      const final = materialized.packages.find((p: { key: string }) => p.key === 'root').content as string;
      const missing = baseline?.text.includes(TLS) && !final.includes(TLS);
      const evidence = [{ sourceIds, target, explanation: 'The candidate retains its approval constraint.' }];
      if (baseline && !options.omitBaselineEvidence) evidence.push({ sourceIds: baseline.content.filter(b => b.path === 'SKILL.md').map(b => b.id), target: { ...target, quote: final.includes(TLS) ? TLS : APPROVAL }, explanation: missing ? 'The original TLS condition is absent from the proposed final body.' : 'Prior constraints remain in the final package.' });
      await execute(params, 'submit_review', { verdict: missing ? 'fail' : 'pass', draftHash: draft.index.draftHash, ...(baseline ? { baselineFingerprint: options.staleFingerprint ?? baseline.index.baselineFingerprint } : {}),
        summary: missing ? 'The prior TLS-verification rule was dropped.' : 'Compared candidate, prior package and final draft.', checks: { preservation: !missing, organization: true, independence: true, grounding: true, injectionSafety: true }, evidence });
    }
    return 'explicitly submitted';
  } };
}

describe('prior-package semantic preservation', () => {
  it('requires complete baseline coverage separately from candidate coverage in both contexts', async () => {
    const candidate = snapshot();
    for (const skip of [{ skipWriterBaseline: true }, { skipReviewerBaseline: true }]) {
      await expect(restructureSkillPackage(candidate, { runner: policy(skip), taskId: 'unread-baseline', baselineSnapshot: candidate })).rejects.toMatchObject({ code: 'SOURCE_UNREAD' });
    }
  });
  it('rejects a short candidate missing an original critical rule even when the candidate itself is coherent', async () => {
    const candidate = snapshot(); const original = snapshot(`${APPROVAL}\n${'Detailed diagnostics.\n'.repeat(500)}${TLS}`);
    await expect(restructureSkillPackage(candidate, { runner: policy(), taskId: 'missing-tls', baselineSnapshot: original, budgets: { maxRepairRounds: 0 } })).rejects.toMatchObject({ code: 'REVIEW_REJECTED' });
  });
  it('allows a grounded repair to restore an omitted prior rule without gratuitous paraphrase', async () => {
    const candidate = snapshot(); const original = snapshot(`${APPROVAL}\n${TLS}`);
    const result = await restructureSkillPackage(candidate, { runner: policy({ repair: true }), taskId: 'restore-tls', baselineSnapshot: original });
    expect(result.kind).toBe('restructured');
    if (result.kind === 'restructured') expect(result.root.content).toContain(TLS);
    expect(result.ruleMappings.some(rule => rule.sourceIds.some(id => id.startsWith('baseline-')))).toBe(true);
    expect(result.baselineFingerprint).toBe(createSkillPackageSnapshot(original).sourceFingerprint);
    expect(result.coverage.baselineWriter?.length).toBeGreaterThan(0);
    expect(result.coverage.baselineReviewer?.length).toBeGreaterThan(0);
  });
  it('retains legitimate additions and treats old resource changes as proposals rather than mandatory baseline copies', async () => {
    const candidate = snapshot(`${APPROVAL}\n${TLS}\nRecord request IDs after successful verification.`);
    candidate.resources = [{ path: 'assets/new.bin', content: 'AP8=', encoding: 'base64', mime_type: 'application/octet-stream', is_executable: false }];
    candidate.manifest = [{ path: 'assets/new.bin', size_bytes: 2, mime_type: 'application/octet-stream', is_executable: false }];
    const original = snapshot(`${APPROVAL}\n${TLS}`);
    original.resources = [{ path: 'assets/old.bin', content: 'AQI=', encoding: 'base64', mime_type: 'application/octet-stream', is_executable: false }];
    original.manifest = [{ path: 'assets/old.bin', size_bytes: 2, mime_type: 'application/octet-stream', is_executable: false }];
    const result = await restructureSkillPackage(candidate, { runner: policy(), taskId: 'legitimate-change', baselineSnapshot: original });
    expect(result.kind).toBe('keep'); expect(result.review.baselineFingerprint).toBe(result.baselineFingerprint);
    expect(result.dispositions).toHaveLength(createSkillPackageSnapshot(candidate).blocks.length);
  });
  it('binds frozen draft/review hashes to the exact prior snapshot and rejects stale or absent baseline evidence', async () => {
    const candidate = snapshot(`${APPROVAL}\n${TLS}`);
    const a = snapshot(`${APPROVAL}\n${TLS}\nOld context A.`), b = snapshot(`${APPROVAL}\n${TLS}\nOld context B.`);
    const first = await restructureSkillPackage(candidate, { runner: policy(), taskId: 'same-candidate-a', baselineSnapshot: a });
    const second = await restructureSkillPackage(candidate, { runner: policy(), taskId: 'same-candidate-b', baselineSnapshot: b });
    expect(first.sourceFingerprint).toBe(second.sourceFingerprint);
    expect(first.baselineFingerprint).not.toBe(second.baselineFingerprint);
    expect(first.frozenDraftHash).not.toBe(second.frozenDraftHash);
    await expect(restructureSkillPackage(candidate, { runner: policy({ staleFingerprint: first.baselineFingerprint }), taskId: 'stale', baselineSnapshot: b })).rejects.toMatchObject({ code: 'INVALID_REVIEW' });
    await expect(restructureSkillPackage(candidate, { runner: policy({ omitBaselineEvidence: true }), taskId: 'no-baseline-evidence', baselineSnapshot: b })).rejects.toMatchObject({ code: 'INVALID_REVIEW' });
  });
  it('charges both packages to the same hard source and read budgets without truncating either', async () => {
    const candidate = snapshot(`${APPROVAL}\n${'a'.repeat(600)}`), original = snapshot(`${APPROVAL}\n${'b'.repeat(600)}`);
    await expect(restructureSkillPackage(candidate, { runner: policy(), taskId: 'combined-source-limit', baselineSnapshot: original, budgets: { maxSourceBytes: 1000 } })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await expect(restructureSkillPackage(candidate, { runner: policy(), taskId: 'combined-read-limit', baselineSnapshot: original, budgets: { maxSourceReadBytes: 2000 } })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });
});
