import { describe, expect, it, vi } from 'vitest';
import { buildPanelApp } from '../../../src/panel/http/app.js';
import type { PanelDeps } from '../../../src/panel/panel-deps.js';
import { EvaluationUnavailableError, type EvaluationDetail } from '../../../src/panel/kernel/ports/evaluation-read-port.js';

const detail: EvaluationDetail = {
  evaluationId: 'demo-e1', title: '合成 E1 Demo', resultLabel: 'INCONCLUSIVE', generatedAt: '2026-08-12T00:00:00Z', sampleCount: 8,
  knowledgeCards: [{ projectionType: 'DISPLAY_ONLY', cardId: 'display-card', title: '展示卡', summary: '未证明暴露', tags: ['合成'] }],
  comparison: [
    { armId: 'K0P0', knowledgeVariant: 'K0', flowVariant: 'P0', recordedAccepted: false, sampleCount: 2 },
    { armId: 'K0P1', knowledgeVariant: 'K0', flowVariant: 'P1', recordedAccepted: false, sampleCount: 2 },
    { armId: 'K1P0', knowledgeVariant: 'K1', flowVariant: 'P0', recordedAccepted: true, sampleCount: 2 },
    { armId: 'K1P1', knowledgeVariant: 'K1', flowVariant: 'P1', recordedAccepted: true, sampleCount: 2 },
  ], metrics: [], evidenceSummaries: ['合成投影'], limitations: ['未运行 Agent'],
  semantics: { evidenceLevel: 'E1', liveAgentExecuted: false, catxCalled: false, externalAuthorityVerified: false, e2Status: 'BLOCKED', runExposure: 'NOT_PROVEN', cardE1BindingHash: null, disclaimer: '合成控制器参考态，仅验证 Demo 契约与展示链路，不代表真实 Agent 收益、线上效果或平台能力' },
  bundleVersion: 'demo', bundleSha256: `sha256:${'a'.repeat(64)}`, sourceMode: 'RECORDED_FIXTURE', tenantScope: 'GLOBAL_SYNTHETIC',
};

function deps(options: { caller?: boolean; member?: boolean; get?: EvaluationDetail | null; unavailable?: boolean } = {}) {
  const { caller = true, member = true, get = detail, unavailable = false } = options;
  const order: string[] = [];
  const value = {
    config: { ui: { distDir: '/nonexistent' } }, logger: { child: () => value.logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    instanceRegistry: { resolve: () => ({ instance_id: 'demo', gateway_endpoint: 'http://mock.invalid', api_key: 'mock-key' }) },
    metaKernel: { invoke: vi.fn(async (action: string) => { order.push(action); if (action === 'auth/verify') return { code: 0, data: caller ? { valid: true, user: { user_id: 'mock-user' } } : { valid: false } }; return { code: member ? 0 : 404, data: member ? { role: 'member' } : null }; }) },
    evaluationRead: { list: vi.fn(async () => { order.push('bundle:list'); if (unavailable) throw new EvaluationUnavailableError('DIGEST_MISMATCH'); return [{ ...detail, cardTitles: ['展示卡'] }]; }), get: vi.fn(async () => { order.push('bundle:get'); if (unavailable) throw new EvaluationUnavailableError('DIGEST_MISMATCH'); return get; }) },
  } as unknown as PanelDeps;
  return { value, order };
}

const headers = { 'content-type': 'application/json', 'x-tdai-service-id': 'demo', 'x-tdai-user-key': 'mock-user-key' };

describe('evaluation routes', () => {
  it('缺 team 在 bundle lookup 前返回 400', async () => {
    const { value, order } = deps(); const app = buildPanelApp(value);
    const response = await app.request('/api/v1/evaluation/list', { method: 'POST', headers, body: '{}' });
    expect(response.status).toBe(400); expect(order).toEqual([]);
  });

  it('严格 caller -> member -> bundle 顺序', async () => {
    const { value, order } = deps(); const app = buildPanelApp(value);
    const response = await app.request('/api/v1/evaluation/list', { method: 'POST', headers, body: JSON.stringify({ team_id: 'mock-team' }) });
    expect(response.status).toBe(200); expect(order).toEqual(['auth/verify', 'team-member/get', 'bundle:list']);
  });

  it('非成员 403 且不探测 bundle', async () => {
    const { value, order } = deps({ member: false }); const app = buildPanelApp(value);
    const response = await app.request('/api/v1/evaluation/get', { method: 'POST', headers, body: JSON.stringify({ team_id: 'mock-team', evaluation_id: 'demo-e1' }) });
    expect(response.status).toBe(403); expect(order).toEqual(['auth/verify', 'team-member/get']);
  });

  it('无效 caller 返回 401 且不探测成员和 bundle', async () => {
    const { value, order } = deps({ caller: false }); const app = buildPanelApp(value);
    const response = await app.request('/api/v1/evaluation/list', { method: 'POST', headers, body: JSON.stringify({ team_id: 'mock-team' }) });
    expect(response.status).toBe(401); expect(order).toEqual(['auth/verify']);
  });

  it('通过 ACL 和有效 bundle 后才返回 404', async () => {
    const { value, order } = deps({ get: null }); const app = buildPanelApp(value);
    const response = await app.request('/api/v1/evaluation/get', { method: 'POST', headers, body: JSON.stringify({ team_id: 'mock-team', evaluation_id: 'missing' }) });
    expect(response.status).toBe(404); expect(order).toEqual(['auth/verify', 'team-member/get', 'bundle:get']);
  });

  it('bundle 摘要失效只返回稳定 503 reason', async () => {
    const { value, order } = deps({ unavailable: true }); const app = buildPanelApp(value);
    const response = await app.request('/api/v1/evaluation/list', { method: 'POST', headers, body: JSON.stringify({ team_id: 'mock-team' }) });
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 503, message: 'DIGEST_MISMATCH' });
    expect(order).toEqual(['auth/verify', 'team-member/get', 'bundle:list']);
  });
});
