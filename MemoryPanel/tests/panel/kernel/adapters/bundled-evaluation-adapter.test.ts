import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BundledEvaluationAdapter } from '../../../../src/panel/kernel/adapters/bundled-evaluation-adapter.js';

const fixtureRoot = path.resolve(process.cwd(), 'evaluation-bundles');
const context = { instanceId: 'demo', teamId: 'mock-team', actorUserId: 'mock-user' };
const expectedSha256 = 'sha256:1a5083dedc77ecff1d37340661c133176b46528d152ee9e750fcc7571de84bc8';

type MutableFixture = {
  evaluations: Array<{
    evaluationId: string;
    generatedAt: string;
    limitations: string[];
    knowledgeCards: Array<{ tags: string[] }>;
    comparison: Array<{ knowledgeVariant: string; sampleCount: number }>;
  }>;
};

describe('BundledEvaluationAdapter', () => {
  it('读取 producer 原始字节，返回固定 E1/NOT_PROVEN/DISPLAY_ONLY 语义', async () => {
    const adapter = new BundledEvaluationAdapter({ enabled: true, bundlePath: path.join(fixtureRoot, 'recorded-e1.json'), expectedSha256, maxBytes: 10_000 });
    const list = await adapter.list(context, { keyword: '契约', resultLabel: 'INCONCLUSIVE' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sourceMode: 'RECORDED_FIXTURE', tenantScope: 'GLOBAL_SYNTHETIC' });
    expect(list[0]?.semantics).toMatchObject({ liveAgentExecuted: false, catxCalled: false, externalAuthorityVerified: false, e2Status: 'BLOCKED', runExposure: 'NOT_PROVEN', cardE1BindingHash: null });
    const detail = await adapter.get(context, list[0]!.evaluationId);
    expect(detail?.knowledgeCards.every((card) => card.projectionType === 'DISPLAY_ONLY')).toBe(true);
  });

  it('一字节篡改 fail-closed 且错误不泄漏路径', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'evaluation-tamper-'));
    const bundlePath = path.join(dir, 'bundle.json');
    const bytes = await readFile(path.join(fixtureRoot, 'recorded-e1.json'));
    bytes[100] = bytes[100] === 0x61 ? 0x62 : 0x61;
    await writeFile(bundlePath, bytes);
    // 即便攻击者同步重写同目录 sidecar，runtime authority 仍是服务端固定 expectedSha256。
    await writeFile(path.join(dir, 'recorded-e1.sha256'), `sha256:${createHash('sha256').update(bytes).digest('hex')}\n`);
    const adapter = new BundledEvaluationAdapter({ enabled: true, bundlePath, expectedSha256, maxBytes: 10_000 });
    await expect(adapter.list(context, {})).rejects.toMatchObject({ reason: 'DIGEST_MISMATCH', message: 'DIGEST_MISMATCH' });
  });

  it('拒绝 symlink 和未知 schema 字段', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'evaluation-link-'));
    const link = path.join(dir, 'bundle.json');
    await symlink(path.join(fixtureRoot, 'recorded-e1.json'), link);
    const linked = new BundledEvaluationAdapter({ enabled: true, bundlePath: link, expectedSha256, maxBytes: 10_000 });
    await expect(linked.list(context, {})).rejects.toMatchObject({ reason: 'WHITELIST_VIOLATION' });

    const invalidPath = path.join(dir, 'invalid.json');
    const value = JSON.parse(await readFile(path.join(fixtureRoot, 'recorded-e1.json'), 'utf8'));
    value.unknown = true;
    const invalidBytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const invalidPin = `sha256:${createHash('sha256').update(invalidBytes).digest('hex')}\n`;
    await writeFile(invalidPath, invalidBytes); await writeFile(path.join(dir, 'invalid.sha256'), invalidPin);
    const invalid = new BundledEvaluationAdapter({ enabled: true, bundlePath: invalidPath, expectedSha256: invalidPin.trim(), maxBytes: 10_000 });
    await expect(invalid.list(context, {})).rejects.toMatchObject({ reason: 'SCHEMA_INVALID' });
  });

  it.each([
    '/etc/passwd', 'C:\\private\\artifact.json', '\\\\server\\share\\artifact.json', '../private.json',
    'evaluator-private/hidden-canary.txt', 'hidden assertion details', '.env.production',
    'ghp_abcdefghijklmnopqrstuvwxyz', 'glpat-abcdefghijklmnopqrstuvwxyz',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue',
    '-----BEGIN PRIVATE KEY-----', 'alice@corp.internal', '+86 13812345678', 'phone +1 415-555-2671',
    'credentialValue=AKIAIOSFODNN7EXAMPLE', 'artifact(/etc/passwd)', 'artifact(../private.json)',
    'artifact[C:\\private\\artifact.json]',
  ])('敏感展示文本 fail-closed: %s', async (forbidden) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'evaluation-sensitive-'));
    const bundlePath = path.join(dir, 'bundle.json');
    const value = JSON.parse(await readFile(path.join(fixtureRoot, 'recorded-e1.json'), 'utf8'));
    value.evaluations[0].limitations[0] = forbidden;
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeFile(bundlePath, bytes);
    const adapter = new BundledEvaluationAdapter({ enabled: true, bundlePath, expectedSha256: digest, maxBytes: 10_000 });
    await expect(adapter.list(context, {})).rejects.toMatchObject({ reason: 'WHITELIST_VIOLATION' });
  });

  it('递归扫描 ID，拒绝重复 tags 和不存在的 UTC 日期', async () => {
    for (const mutate of [
      (value: MutableFixture) => { value.evaluations[0]!.evaluationId = 'ghp_abcdefghijklmnopqrstuvwxyz'; },
      (value: MutableFixture) => { value.evaluations[0]!.knowledgeCards[0]!.tags = ['合成', '合成']; },
      (value: MutableFixture) => { value.evaluations[0]!.generatedAt = '2026-99-99T99:99:99Z'; },
    ]) {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'evaluation-strict-'));
      const bundlePath = path.join(dir, 'bundle.json');
      const value = JSON.parse(await readFile(path.join(fixtureRoot, 'recorded-e1.json'), 'utf8')) as MutableFixture;
      mutate(value);
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      await writeFile(bundlePath, bytes);
      const adapter = new BundledEvaluationAdapter({ enabled: true, bundlePath, expectedSha256: digest, maxBytes: 10_000 });
      await expect(adapter.list(context, {})).rejects.toMatchObject({
        reason: value.evaluations[0]!.evaluationId.startsWith('ghp_') ? 'WHITELIST_VIOLATION' : 'SCHEMA_INVALID',
      });
    }
  });

  it('拒绝四臂 identity 映射与 sampleCount 漂移', async () => {
    for (const mutate of [
      (value: MutableFixture) => { value.evaluations[0]!.comparison[0]!.knowledgeVariant = 'K1'; },
      (value: MutableFixture) => { value.evaluations[0]!.comparison[0]!.sampleCount = 1; },
    ]) {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'evaluation-arm-'));
      const bundlePath = path.join(dir, 'bundle.json');
      const value = JSON.parse(await readFile(path.join(fixtureRoot, 'recorded-e1.json'), 'utf8'));
      mutate(value);
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      await writeFile(bundlePath, bytes);
      const adapter = new BundledEvaluationAdapter({ enabled: true, bundlePath, expectedSha256: digest, maxBytes: 10_000 });
      await expect(adapter.list(context, {})).rejects.toMatchObject({ reason: 'SCHEMA_INVALID' });
    }
  });
});
