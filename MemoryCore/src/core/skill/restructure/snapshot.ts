import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SkillRestructureError, type FrozenSkillPackageSnapshot, type SkillPackageSnapshot, type SourceBlock } from './types.js';

export const MAX_BODY_CHARS = 50_000;
export const MAX_RESOURCE_BYTES = 5_000_000;
export const MAX_PACKAGE_BYTES = 50_000_000;
export const HARD_BUDGETS = Object.freeze({
  blockBytes: 16_384, maxSourceBytes: 4_000_000, maxSourceReadBytes: 32_000_000,
  maxOutputBytes: 8_000_000, maxSteps: 512, maxCalls: 12,
  maxTokensPerCall: 32_768, deadlineMs: 600_000, maxRetries: 2, maxRepairRounds: 2,
});
export const DEFAULT_BUDGETS = Object.freeze({
  blockBytes: 8_192, maxSourceBytes: 1_000_000, maxSourceReadBytes: 8_000_000,
  maxOutputBytes: 2_000_000, maxSteps: 192, maxCalls: 6,
  maxTokensPerCall: 16_384, deadlineMs: 180_000, maxRetries: 1, maxRepairRounds: 1,
});
const payloadSchema = z.object({
  path: z.string(), content: z.string(), encoding: z.enum(['utf-8', 'base64']),
  mime_type: z.string().optional(), is_executable: z.boolean().optional(),
}).strict();
const snapshotSchema = z.object({
  skill_id: z.string().min(1).max(256), version: z.number().int().nonnegative(), name: z.string().min(1).max(256),
  content: z.string(), identity: z.record(z.string(), z.json()), metadata: z.record(z.string(), z.json()),
  manifest: z.array(z.object({ path: z.string(), size_bytes: z.number().int().nonnegative(), mime_type: z.string().min(1), is_executable: z.boolean(), content_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).max(4096),
  resources: z.array(payloadSchema).max(4096),
}).strict();

export function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
/** Stable serialization also rejects lossy Unicode in metadata, not just body text. */
export function canonical(value: unknown): string {
  if (typeof value === 'string') { assertUnicode(value); return JSON.stringify(value); }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${canonical(k)}:${canonical(v)}`).join(',')}}`;
  throw new Error('Non-JSON value');
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function assertUnicode(value: string): void {
  // Buffer silently replaces lone surrogates; never let that change reviewed bytes.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error('Invalid Unicode surrogate');
}
export function assertResourcePath(path: string): void {
  assertUnicode(path);
  if (!path || path.length > 512 || path !== path.normalize('NFC') || /[\\\x00-\x20\x7f:%?#]/u.test(path)
    || path.startsWith('/') || path.endsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))
    || /^(?:files\/|skill\.md$)/i.test(path)) throw new Error(`Invalid or aliased resource path: ${path}`);
}
export function assertResourcePaths(paths: string[]): void {
  for (const path of paths) assertResourcePath(path);
  const aliases = new Set(paths.map(path => path.toLowerCase()));
  if (aliases.size !== paths.length) throw new Error('Duplicate resource path alias');
  for (const path of aliases) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (aliases.has(parts.slice(0, i).join('/'))) throw new Error(`Resource is both a file and directory: ${path}`);
  }
}
export function resourceBytes(resource: { content: string; encoding: 'utf-8' | 'base64' }): Buffer {
  assertUnicode(resource.content);
  if (resource.encoding === 'utf-8') return Buffer.from(resource.content, 'utf-8');
  // Avoid nested repetition: valid 5MB binaries can overflow regexp backtracking stacks.
  if (resource.content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(resource.content)) throw new Error('Invalid base64 resource');
  const bytes = Buffer.from(resource.content, 'base64');
  if (bytes.toString('base64') !== resource.content) throw new Error('Non-canonical base64 resource');
  return bytes;
}
export function isTextResource(resource: { path: string; encoding: string; mime_type?: string; is_executable?: boolean }): boolean {
  return resource.encoding === 'utf-8' || /^(?:text\/|application\/(?:json|xml|javascript|yaml|x-shellscript))/i.test(resource.mime_type ?? '')
    || /\.(?:md|txt|rst|sh|bash|zsh|py|js|ts|jsx|tsx|json|ya?ml|toml|ini|cfg|csv|xml|html|css|sql|ps1|bat|cmd|rb|pl|go|rs|java|c|h|cpp)$/i.test(resource.path);
}
export function textBlocks(path: string, text: string, blockBytes: number): SourceBlock[] {
  assertUnicode(text);
  const bytes = Buffer.from(text, 'utf-8');
  if (Math.ceil(bytes.length / blockBytes) > 8192) throw new SkillRestructureError('BUDGET_EXCEEDED', 'Source requires too many bounded blocks', 'snapshot');
  const out: SourceBlock[] = [];
  for (let offset = 0; offset < bytes.length || out.length === 0;) {
    let end = Math.min(offset + blockBytes, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end === offset && bytes.length > 0) throw new Error('Block budget cannot fit a UTF-8 code point');
    const part = bytes.subarray(offset, end);
    const digest = hash(part);
    out.push({ id: `src-${hash(path).slice(0, 16)}-${offset}-${digest.slice(0, 16)}`, path, kind: 'text', hash: digest, sizeBytes: part.length, offset, content: part.toString('utf-8') });
    offset = end;
    if (offset === bytes.length) break;
  }
  return out;
}

export function createSkillPackageSnapshot(input: SkillPackageSnapshot, options: { blockBytes?: number; maxSourceBytes?: number } = {}): FrozenSkillPackageSnapshot {
  try {
    const blockBytes = options.blockBytes ?? DEFAULT_BUDGETS.blockBytes;
    const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_BUDGETS.maxSourceBytes;
    if (!Number.isInteger(blockBytes) || blockBytes < 4 || blockBytes > HARD_BUDGETS.blockBytes || !Number.isInteger(maxSourceBytes) || maxSourceBytes < 1 || maxSourceBytes > HARD_BUDGETS.maxSourceBytes) throw new Error('Invalid snapshot budgets');
    // Recompute derived fields even when the caller passes our own frozen output.
    const { sourceFingerprint: _fingerprint, blocks: _blocks, resourceHashes: _hashes, ...raw } = input as FrozenSkillPackageSnapshot;
    const parsed = snapshotSchema.parse(raw);
    const serialized = canonical(parsed);
    if (Buffer.byteLength(serialized) > 72_000_000) throw new SkillRestructureError('BUDGET_EXCEEDED', 'Snapshot envelope exceeds hard byte limit', 'snapshot');
    if (Buffer.byteLength(parsed.content) > maxSourceBytes) throw new SkillRestructureError('BUDGET_EXCEEDED', 'Complete source body exceeds text budget', 'snapshot');
    const manifests = new Map(parsed.manifest.map(m => [m.path, m]));
    assertResourcePaths(parsed.manifest.map(m => m.path));
    if (manifests.size !== parsed.resources.length) throw new Error('Incomplete resource payloads');
    const resourceHashes: Record<string, string> = Object.create(null);
    const blocks = textBlocks('SKILL.md', parsed.content, blockBytes);
    let total = 0;
    let textBytes = Buffer.byteLength(parsed.content, 'utf-8');
    const seen = new Set<string>();
    for (const resource of parsed.resources) {
      assertResourcePath(resource.path);
      const m = manifests.get(resource.path);
      if (!m || seen.has(resource.path)) throw new Error(`Missing or duplicated resource: ${resource.path}`);
      seen.add(resource.path);
      if (resource.mime_type !== undefined && resource.mime_type !== m.mime_type || resource.is_executable !== undefined && resource.is_executable !== m.is_executable) throw new Error(`Resource attributes disagree: ${resource.path}`);
      resource.mime_type = m.mime_type;
      resource.is_executable = m.is_executable;
      const bytes = resourceBytes(resource);
      if (bytes.length !== m.size_bytes) throw new Error(`Missing or truncated resource bytes: ${resource.path}`);
      if (bytes.length > MAX_RESOURCE_BYTES) throw new Error(`Resource exceeds 5MB: ${resource.path}`);
      total += bytes.length;
      resourceHashes[resource.path] = hash(bytes);
      if (m.content_sha256 !== undefined && m.content_sha256 !== resourceHashes[resource.path]) throw new Error(`Resource hash mismatch: ${resource.path}`);
      if (isTextResource(resource)) {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        textBytes += bytes.length;
        blocks.push(...textBlocks(resource.path, text, blockBytes));
      } else {
        blocks.push({ id: `src-${hash(resource.path).slice(0, 16)}-binary-${hash(bytes).slice(0, 16)}`, path: resource.path, kind: 'binary', hash: hash(bytes), sizeBytes: bytes.length, offset: 0 });
      }
    }
    if (blocks.length > 8192) throw new SkillRestructureError('BUDGET_EXCEEDED', 'Package requires too many source blocks', 'snapshot');
    if (total > MAX_PACKAGE_BYTES) throw new Error('Package resources exceed 50MB');
    if (textBytes > maxSourceBytes) throw new SkillRestructureError('BUDGET_EXCEEDED', `Complete text source ${textBytes} exceeds budget ${maxSourceBytes}`, 'snapshot');
    const byPath = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    blocks.sort((a, b) => byPath(a, b) || a.offset - b.offset);
    const sourceFingerprint = hash(canonical({ ...parsed, manifest: [...parsed.manifest].sort(byPath), resources: [...parsed.resources].sort(byPath).map(r => ({ ...r, content: undefined, hash: resourceHashes[r.path] })) }));
    return freeze({ ...parsed, sourceFingerprint, blocks, resourceHashes });
  } catch (error) {
    if (error instanceof SkillRestructureError) throw error;
    throw new SkillRestructureError('INVALID_SNAPSHOT', error instanceof Error ? error.message : 'Invalid snapshot', 'snapshot');
  }
}
