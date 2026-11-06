import { posix } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { SkillRestructureError, type DraftPackage, type DraftTarget, type FrozenSkillPackageSnapshot, type RestructureDraft, type ReviewedPackage, type RuleMapping, type SemanticReview } from './types.js';
import { assertResourcePath, assertResourcePaths, assertUnicode, canonical, hash, isTextResource, MAX_BODY_CHARS, MAX_PACKAGE_BYTES, MAX_RESOURCE_BYTES, resourceBytes } from './snapshot.js';

const boundedText = z.string().min(1).max(10_000);
const sourceIds = z.array(z.string().min(1).max(160)).min(1).max(4096);
export const targetSchema = z.object({ packageKey: z.string().min(1).max(80), path: z.string().min(1).max(512), quote: z.string().min(1).max(10_000).optional() }).strict();
const resourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('copy_from'), path: z.string().max(512), sourcePath: z.string().max(512) }).strict(),
  z.object({ kind: z.literal('write'), path: z.string().max(512), content: z.string().max(MAX_RESOURCE_BYTES), encoding: z.literal('utf-8'), mime_type: z.string().max(256).optional(), is_executable: z.boolean().optional() }).strict(),
]);
const packageSchema = z.object({ key: z.string().min(1).max(80), name: z.string().min(1).max(256), content: z.string().min(1).max(MAX_BODY_CHARS), resources: z.array(resourceSchema).max(4096), children: z.array(z.string().min(1).max(80)).max(16) }).strict();
export const draftSchema = z.object({
  kind: z.enum(['keep', 'restructure']), rationale: boundedText, root: packageSchema.optional(), children: z.array(packageSchema).max(16),
  dispositions: z.array(z.object({ sourceId: z.string().max(160), action: z.enum(['preserve', 'rewrite', 'remove']), reason: boundedText, targets: z.array(targetSchema).max(64) }).strict()).max(8192),
  ruleMappings: z.array(z.object({ rule: boundedText, critical: z.boolean(), scope: z.enum(['package', 'global']).optional(), ownerPackageKey: z.string().min(1).max(80).optional(), appliesTo: z.array(z.string().min(1).max(80)).max(16).optional(), sourceIds, targets: z.array(targetSchema).min(1).max(64) }).strict()).min(1).max(2048),
  transformations: z.array(z.object({ kind: z.enum(['deduplicate', 'remove_narrative', 'synthesize', 'split_capability']), sourceIds, before: boundedText, explanation: boundedText, after: targetSchema }).strict()).max(2048),
}).strict();
export const reviewSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'insufficient']), draftHash: z.string().regex(/^[a-f0-9]{64}$/), baselineFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), summary: boundedText,
  checks: z.object({ preservation: z.boolean(), organization: z.boolean(), independence: z.boolean(), grounding: z.boolean(), injectionSafety: z.boolean() }).strict(),
  evidence: z.array(z.object({ sourceIds, target: targetSchema.optional(), explanation: boundedText }).strict()).max(4096),
}).strict();

function frontmatter(content: string): Record<string, unknown> {
  if (!/^---\r?\n/.test(content)) return {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('Unterminated frontmatter');
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid YAML frontmatter');
  const result: unknown = document.toJS({ maxAliasCount: 0 });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Frontmatter must be an object');
  canonical(result);
  return result as Record<string, unknown>;
}
function originalPackage(snapshot: FrozenSkillPackageSnapshot): DraftPackage {
  return { key: 'root', name: snapshot.name, content: snapshot.content, resources: snapshot.resources.map(r => ({ kind: 'copy_from', path: r.path, sourcePath: r.path })), children: [] };
}
export function materializePackages(snapshot: FrozenSkillPackageSnapshot, draft: RestructureDraft): ReviewedPackage[] {
  return (draft.kind === 'keep' ? [originalPackage(snapshot)] : [draft.root!, ...draft.children]).map(p => ({
    key: p.key, name: p.name, content: p.content, children: [...p.children], resourcePlans: p.resources,
    identity: structuredClone(snapshot.identity), metadata: p.key === 'root' ? structuredClone(snapshot.metadata) : {},
    resources: p.resources.map(r => {
      if (r.kind === 'write') {
        const { kind: _kind, ...payload } = r;
        return payload;
      }
      const source = snapshot.resources.find(source => source.path === r.sourcePath);
      if (!source) throw new Error(`Unknown copy_from source: ${r.sourcePath}`);
      return { ...source, path: r.path };
    }),
  }));
}
function targetText(target: DraftTarget, packages: ReviewedPackage[]): string | undefined {
  const p = packages.find(p => p.key === target.packageKey);
  if (!p) throw new Error(`Unknown target package: ${target.packageKey}`);
  if (target.path === 'SKILL.md') return p.content;
  assertResourcePath(target.path);
  const r = p.resources.find(r => r.path === target.path);
  if (!r) throw new Error(`Target does not own resource: ${target.packageKey}/${target.path}`);
  return isTextResource(r) ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(resourceBytes(r)) : undefined;
}
function assertTarget(target: DraftTarget, packages: ReviewedPackage[], quoteRequired = false): void {
  const text = targetText(target, packages);
  if (quoteRequired && !target.quote) throw new Error('Text evidence needs a literal target quote');
  if (target.quote && (text === undefined || !text.includes(target.quote))) throw new Error(`Target quote not found: ${target.packageKey}/${target.path}`);
}
function ruleOwners(rule: RuleMapping, packages: ReviewedPackage[]): string[] {
  const owner = rule.ownerPackageKey ?? 'root';
  if (!packages.some(p => p.key === owner)) throw new Error(`Unknown rule owner: ${owner}`);
  if (rule.scope !== 'global') {
    if (rule.appliesTo !== undefined) throw new Error('Only global rules declare applicable children');
    return [owner];
  }
  if (owner !== 'root') throw new Error('Global rules are rooted in the parent package');
  const children = rule.appliesTo ?? packages.filter(p => p.key !== 'root').map(p => p.key);
  if (new Set(children).size !== children.length || children.some(key => key === 'root' || !packages.some(p => p.key === key))) throw new Error('Invalid global-rule applicability');
  return ['root', ...children];
}
function occurrences(text: string, excerpt: string): number {
  let count = 0, offset = 0;
  while ((offset = text.indexOf(excerpt, offset)) !== -1) { count++; offset += excerpt.length; }
  return count;
}
function markdownContent(text: string): string {
  const lines = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').split(/\r?\n/);
  let fence: { char: string; length: number } | undefined;
  return lines.map(line => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
      return '';
    }
    if (match) { fence = { char: match[1][0], length: match[1].length }; return ''; }
    return line;
  }).join('\n');
}
function markdownAnchors(text: string): Set<string> {
  const prose = markdownContent(text);
  const anchors = new Set([...prose.matchAll(/<[a-z][^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]));
  const used = new Map<string, number>();
  const lines = prose.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const atx = lines[i].match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
    const setext = i > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i]) && lines[i - 1].trim() ? lines[i - 1].trim() : undefined;
    let title = atx?.[1] ?? setext;
    if (!title) continue;
    const explicit = title.match(/\s*\{#([^}]+)\}\s*$/);
    if (explicit) { anchors.add(explicit[1]); title = title.slice(0, explicit.index); }
    // Common GitHub-style heading IDs, including Unicode and duplicate headings.
    const slug = title.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const occurrence = used.get(slug) ?? 0;
    let anchor = occurrence ? `${slug}-${occurrence}` : slug;
    let suffix = occurrence;
    while (anchors.has(anchor)) anchor = `${slug}-${++suffix}`;
    anchors.add(anchor); used.set(slug, suffix + 1);
  }
  return anchors;
}
function isMarkdown(owner: ReviewedPackage, path: string): boolean {
  return path === 'SKILL.md' || /\.(?:md|markdown|mdown|mdx)$/i.test(path) || /markdown/i.test(owner.resources.find(r => r.path === path)?.mime_type ?? '');
}
function assertReferences(text: string, owner: ReviewedPackage, currentPath: string, all: ReviewedPackage[], source: FrozenSkillPackageSnapshot): void {
  if (!isMarkdown(owner, currentPath)) return;
  // Code examples are not executable navigation. Workspace commands and external URLs are not attachments.
  const prose = markdownContent(text);
  const markers = [...prose.matchAll(/\{\{skill:([^}]+)\}\}/g)].map(m => m[1]);
  for (const key of markers) if (!owner.children.includes(key) || !all.some(p => p.key === key)) throw new Error(`Undeclared child marker: ${key}`);
  if (/\{\{skill:/.test(prose.replace(/\{\{skill:[^}]+\}\}/g, ''))) throw new Error('Malformed child marker');
  const linksText = prose.replace(/(`+)[^\n]*?\1/g, '');
  const links = [...linksText.matchAll(/!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^\n]*?["'])?\s*\)/g)].map(m => m[1]);
  links.push(...[...linksText.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)/gm)].map(m => m[1]));
  for (const link of links) {
    if (/^(?:https?:|mailto:|data:|ftp:|\/\/)/i.test(link)) continue;
    const explicit = link.startsWith('skill-resource:');
    if (!explicit && /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
    const href = explicit ? link.slice('skill-resource:'.length) : link;
    const hashOffset = href.indexOf('#');
    const fragment = hashOffset < 0 ? '' : decodeURIComponent(href.slice(hashOffset + 1));
    const decoded = decodeURIComponent(href.split(/[?#]/)[0]);
    const resolved = decoded ? posix.normalize(posix.join(posix.dirname(currentPath), decoded)) : currentPath;
    const owned = !decoded || resolved === 'SKILL.md' || explicit || /^(?:\.\.?\/)*(?:files\/)?(?:references|scripts|templates|assets)\//.test(decoded)
      || /^(?:references|scripts|templates|assets)\//.test(resolved)
      || owner.resources.some(r => r.path === resolved) || source.resources.some(r => r.path === resolved);
    if (!owned) continue;
    const path = resolved.replace(/^files\//, '');
    const target = { packageKey: owner.key, path };
    assertTarget(target, all);
    if (fragment && isMarkdown(owner, path) && !markdownAnchors(targetText(target, all)!).has(fragment)) throw new Error(`Missing owned Markdown anchor: ${path}#${fragment}`);
  }
}

export function validateDraft(snapshot: FrozenSkillPackageSnapshot, input: unknown, readIds: ReadonlySet<string>, baseline?: FrozenSkillPackageSnapshot, baselineReadIds: ReadonlySet<string> = new Set()): { draft: RestructureDraft; packages: ReviewedPackage[] } {
  try {
    const draft: RestructureDraft = draftSchema.parse(input);
    canonical(draft);
    const missingReads = snapshot.blocks.filter(b => b.kind === 'text' && !readIds.has(b.id)).map(b => b.id);
    if (missingReads.length) throw new SkillRestructureError('SOURCE_UNREAD', 'Every source text block must be read before submission', 'validate', { missing: missingReads });
    const unreadBaseline = baseline?.blocks.filter(block => block.kind === 'text' && !baselineReadIds.has(block.id)) ?? [];
    if (unreadBaseline.length) throw new SkillRestructureError('SOURCE_UNREAD', 'Read the complete original baseline before submitting a candidate judgment', 'validate', { missing: unreadBaseline.map(block => block.id), context: 'baseline' });
    if (draft.kind === 'keep') {
      if (draft.root || draft.children.length || draft.transformations.length) throw new Error('keep cannot change packages');
    } else if (!draft.root || draft.root.key !== 'root' || draft.root.name !== snapshot.name) throw new Error('Root identity/name must remain unchanged');
    const packages = materializePackages(snapshot, draft);
    const names = new Set<string>(); const keys = new Set<string>();
    for (const p of packages) {
      if (!/^[a-z][a-z0-9-]{0,79}$/.test(p.key) || keys.has(p.key) || names.has(p.name.toLowerCase())) throw new Error('Invalid/duplicate package key or name');
      if (p.key !== 'root' && (!/^[a-z][a-z0-9-]{1,63}$/.test(p.name) || p.name === snapshot.name)) throw new Error('Child must have a distinct class-level slug name');
      keys.add(p.key); names.add(p.name.toLowerCase());
      assertUnicode(p.content);
      if (p.content.length > MAX_BODY_CHARS) throw new Error('Final body exceeds 50k characters, including keep candidates');
      const fm = frontmatter(p.content);
      if (typeof fm.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(fm.name) || fm.name !== p.name) throw new Error('Invalid frontmatter name or package name mismatch');
      if (typeof fm.description !== 'string' || !fm.description.trim() || fm.description.length > 1024) throw new Error('Final frontmatter requires a description of 1..1024 characters');
      const originalFields = frontmatter(snapshot.content);
      if (baseline && p.key === 'root') {
        if (p.name !== baseline.name) throw new Error('The prior root name cannot change');
        for (const [key, value] of Object.entries(frontmatter(baseline.content))) {
          if (key !== 'description' && key !== 'resources' && (!Object.hasOwn(fm, key) || canonical(fm[key]) !== canonical(value))) throw new Error(`Prior protected/extension field changed: ${key}`);
        }
        for (const [key, value] of Object.entries(baseline.metadata)) if (!Object.hasOwn(p.metadata, key) || canonical(p.metadata[key]) !== canonical(value)) throw new Error(`Prior user metadata changed: ${key}`);
      }
      const protectedField = (key: string) => /^(?:protected|pinned|allowed[-_]?tools|denied[-_]?tools|permissions?|disable-model-invocation|user-invocable|hooks|context|agent)$/i.test(key);
      for (const [key, value] of Object.entries(originalFields)) {
        if (p.key === 'root' ? key === 'description' || key === 'resources' : !protectedField(key)) continue;
        if (canonical(fm[key]) !== canonical(value)) throw new Error(`Protected original frontmatter field changed: ${key}`);
      }
      for (const [key, value] of Object.entries(fm)) {
        if (protectedField(key) && !Object.hasOwn(originalFields, key)) throw new Error(`Cannot introduce unapproved permission/protection field: ${key}`);
        if (p.key !== 'root' && !['name', 'description', 'category', 'resources'].includes(key) && !protectedField(key)) {
          if (!Object.hasOwn(originalFields, key) || canonical(value) !== canonical(originalFields[key])) throw new Error(`Child changed unknown original extension: ${key}`);
        }
      }
      if (fm.resources !== undefined) {
        const declared = z.array(z.object({ path: z.string(), type: z.enum(['text', 'executable', 'binary']) }).passthrough()).parse(fm.resources);
        assertResourcePaths(declared.map(r => r.path));
        if (declared.length !== p.resources.length) throw new Error('Frontmatter resources must match the final owned manifest');
        for (const entry of declared) {
          const resource = p.resources.find(r => r.path === entry.path);
          if (!resource) throw new Error(`Frontmatter references missing resource: ${entry.path}`);
          const actualType = resource.is_executable ? 'executable' : isTextResource(resource) ? 'text' : 'binary';
          if (entry.type !== actualType) throw new Error(`Frontmatter resource type disagrees with attributes: ${entry.path}`);
        }
      }
      assertResourcePaths(p.resources.map(r => r.path));
      let bytes = 0;
      for (const r of p.resources) {
        const size = resourceBytes(r).length;
        if (size > MAX_RESOURCE_BYTES) throw new Error('Resource exceeds 5MB');
        bytes += size;
      }
      if (bytes > MAX_PACKAGE_BYTES) throw new Error('Package resources exceed 50MB');
    }
    const visited = new Set<string>(); const active = new Set<string>();
    function visit(key: string) {
      if (active.has(key)) throw new Error('Child capability cycle');
      if (visited.has(key)) return;
      const p = packages.find(p => p.key === key);
      if (!p) throw new Error(`Missing child: ${key}`);
      if (new Set(p.children).size !== p.children.length) throw new Error('Duplicate child edge');
      active.add(key);
      for (const child of p.children) {
        if (!markdownContent(p.content).includes(`{{skill:${child}}}`)) throw new Error(`Missing explicit child navigation marker: ${child}`);
        visit(child);
      }
      active.delete(key); visited.add(key);
    }
    visit('root');
    if (visited.size !== packages.length) throw new Error('Unreachable child package');
    for (const p of packages) {
      assertReferences(p.content, p, 'SKILL.md', packages, snapshot);
      for (const r of p.resources) if (isTextResource(r)) assertReferences(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(resourceBytes(r)), p, r.path, packages, snapshot);
    }
    const sources = new Map(snapshot.blocks.map(b => [b.id, b])); const dispositions = new Set<string>();
    for (const d of draft.dispositions) {
      const source = sources.get(d.sourceId);
      if (!source || dispositions.has(d.sourceId)) throw new Error('Unknown/duplicate source disposition');
      dispositions.add(d.sourceId);
      for (const target of d.targets) assertTarget(target, packages);
      if (d.action !== 'remove' && !d.targets.length) throw new Error('Preserved/rewritten source needs a target');
      if (draft.kind === 'keep' && (d.action !== 'preserve' || !d.targets.some(t => t.packageKey === 'root' && t.path === source.path))) throw new Error('keep must preserve every source');
      if (source.kind === 'binary') {
        if (d.action !== 'preserve' || !d.targets.some(t => {
          const p = packages.find(p => p.key === t.packageKey);
          return p?.resourcePlans.some(r => r.kind === 'copy_from' && r.path === t.path && r.sourcePath === source.path);
        })) throw new Error(`Binary must be copied without changing bytes/attributes: ${source.path}`);
      } else if (d.action === 'preserve' && !d.targets.some(t => targetText(t, packages)?.includes(source.content!))) throw new Error(`Preserve disposition changed source: ${source.id}`);
    }
    if (dispositions.size !== sources.size) throw new Error('Every source block needs a disposition');
    const evidenceBlocks = [...snapshot.blocks, ...(baseline?.blocks ?? [])];
    const evidenceSources = new Map(evidenceBlocks.map(block => [block.id, block]));
    const assertSources = (ids: string[]) => { for (const id of ids) if (!evidenceSources.has(id) || evidenceSources.get(id)!.kind !== 'text') throw new Error('Evidence references an unknown/nontext source'); };
    for (const rule of draft.ruleMappings) {
      assertSources(rule.sourceIds);
      for (const target of rule.targets) assertTarget(target, packages, true);
      const owners = ruleOwners(rule, packages);
      if (rule.critical) for (const owner of owners) if (!rule.targets.some(t => t.packageKey === owner && t.path === 'SKILL.md')) throw new Error(`Critical rule must remain in its applicable owner's SKILL.md: ${owner}`);
    }
    if (draft.kind === 'restructure') {
      const finalTexts = packages.flatMap(p => [p.content, ...p.resources.filter(isTextResource).map(r => resourceBytes(r).toString('utf-8'))]);
      const allSourceText = snapshot.blocks.filter(b => b.kind === 'text').map(b => b.content!).join('\n');
      if (!draft.transformations.length) throw new Error('Restructuring needs source-backed semantic or independent-capability evidence');
      for (const t of draft.transformations) {
        assertSources(t.sourceIds); assertTarget(t.after, packages, true);
        // Versions are alternative contexts, not duplicate occurrences to sum together.
        const quotedContexts = [snapshot.blocks, ...(baseline ? [baseline.blocks] : [])]
          .map(blocks => blocks.filter(block => t.sourceIds.includes(block.id)).map(block => block.content ?? '').join(''));
        const before = quotedContexts.find(text => text.includes(t.before));
        if (before === undefined) throw new Error('Transformation lacks literal source evidence');
        const sourceCount = occurrences(before, t.before);
        const finalCount = finalTexts.reduce((sum, text) => sum + occurrences(text, t.before), 0);
        const unchangedWording = t.before.replace(/\s+/g, ' ').trim() === t.after.quote!.replace(/\s+/g, ' ').trim();
        const restoresPriorRule = Boolean(baseline && t.sourceIds.some(id => baseline.blocks.some(block => block.id === id)) && !allSourceText.includes(t.before) && t.after.quote!.includes(t.before));
        if (t.kind === 'split_capability') {
          if (t.after.packageKey === 'root' || t.after.path !== 'SKILL.md') throw new Error('Independent split evidence must point to the new child capability');
        } else if (t.kind === 'deduplicate' && unchangedWording) {
          const normalized = t.before.replace(/\s+/g, ' ').trim();
          const originalOccurrences = occurrences(before.replace(/\s+/g, ' '), normalized);
          const retainedOccurrences = finalTexts.reduce((sum, text) => sum + occurrences(text.replace(/\s+/g, ' '), normalized), 0);
          if (originalOccurrences <= retainedOccurrences || retainedOccurrences < 1) throw new Error('Verbatim deduplication must demonstrably reduce repeated occurrences while retaining the rule');
        } else if (!restoresPriorRule && (unchangedWording || (finalCount >= sourceCount && allSourceText.includes(t.after.quote!)))) {
          throw new Error('Transformation evidence shows only relocation, not synthesis or deduplication');
        }
        if (t.kind === 'remove_narrative' && finalCount > 0) throw new Error('Removed narration is still present');
      }
      if (packages.length === 1 && packages[0].content === snapshot.content && canonical(packages[0].resources) === canonical(snapshot.resources)) throw new Error('Unchanged package must use keep');
    }
    return { draft, packages };
  } catch (error) {
    if (error instanceof SkillRestructureError) throw error;
    throw new SkillRestructureError('INVALID_DRAFT', error instanceof Error ? error.message : 'Invalid draft', 'validate');
  }
}

export function validateReview(snapshot: FrozenSkillPackageSnapshot, draft: RestructureDraft, packages: ReviewedPackage[], input: unknown, draftHash: string, baseline?: FrozenSkillPackageSnapshot): SemanticReview {
  try {
    const review: SemanticReview = reviewSchema.parse(input);
    canonical(review);
    if (review.draftHash !== draftHash) throw new Error('Reviewer inspected a different draft');
    if (review.baselineFingerprint !== baseline?.sourceFingerprint) throw new Error('Reviewer did not attest the exact original baseline');
    const evidenceBlocks = [...snapshot.blocks, ...(baseline?.blocks ?? [])];
    for (const evidence of review.evidence) {
      for (const id of evidence.sourceIds) if (!evidenceBlocks.some(b => b.id === id && b.kind === 'text')) throw new Error('Review cites nonexistent source evidence');
      if (evidence.target) assertTarget(evidence.target, packages, true);
    }
    if (review.verdict === 'pass') {
      if (!Object.values(review.checks).every(Boolean) || !review.evidence.length) throw new Error('Passing review lacks complete checks/evidence');
      if (baseline && !review.evidence.some(evidence => evidence.target && evidence.sourceIds.some(id => baseline.blocks.some(block => block.id === id && block.kind === 'text')))) throw new Error('Passing review lacks original-baseline preservation evidence');
      for (const rule of draft.ruleMappings) {
        const evidenced = (targets: DraftTarget[]) => review.evidence.some(e => rule.sourceIds.some(id => e.sourceIds.includes(id)) && e.target && targets.some(t => t.packageKey === e.target!.packageKey && t.path === e.target!.path && e.target!.quote!.includes(t.quote!)));
        if (!evidenced(rule.targets)) throw new Error('Passing review did not evidence each mapped rule');
        if (rule.critical) for (const owner of ruleOwners(rule, packages)) {
          if (!evidenced(rule.targets.filter(t => t.packageKey === owner && t.path === 'SKILL.md'))) throw new Error(`Passing review did not evidence a critical rule in its applicable owner: ${owner}`);
        }
      }
      for (const child of draft.children) if (!review.evidence.some(e => e.target?.packageKey === child.key && e.target.path === 'SKILL.md')) throw new Error(`Passing review lacks independent-capability evidence for child: ${child.key}`);
    }
    return review;
  } catch (error) {
    throw new SkillRestructureError('INVALID_REVIEW', error instanceof Error ? error.message : 'Invalid review', 'review');
  }
}

export function frozenDraftHash(draft: RestructureDraft, context?: { sourceFingerprint: string; baselineFingerprint: string }): string {
  return hash(canonical(context ? { draft, ...context } : draft));
}
