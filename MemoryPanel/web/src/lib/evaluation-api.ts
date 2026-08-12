import { getPanelSession } from './panelSession';

export type EvaluationResultLabel = 'POSITIVE' | 'INCONCLUSIVE' | 'NEGATIVE';

export interface EvaluationSemantics {
  evidenceLevel: 'E1';
  liveAgentExecuted: false;
  catxCalled: false;
  externalAuthorityVerified: false;
  e2Status: 'BLOCKED';
  runExposure: 'NOT_PROVEN';
  cardE1BindingHash: null;
  disclaimer: string;
}

export interface EvaluationListItem {
  evaluationId: string;
  title: string;
  resultLabel: EvaluationResultLabel;
  generatedAt: string;
  sampleCount: number;
  cardTitles: string[];
  semantics: EvaluationSemantics;
  bundleVersion: string;
  bundleSha256: string;
  sourceMode: 'RECORDED_FIXTURE';
  tenantScope: 'GLOBAL_SYNTHETIC';
}

export interface EvaluationDetail extends Omit<EvaluationListItem, 'cardTitles'> {
  knowledgeCards: Array<{ projectionType: 'DISPLAY_ONLY'; cardId: string; title: string; summary: string; tags: string[] }>;
  comparison: Array<{ armId: 'K0P0' | 'K0P1' | 'K1P0' | 'K1P1'; knowledgeVariant: 'K0' | 'K1'; flowVariant: 'P0' | 'P1'; recordedAccepted: boolean; sampleCount: number }>;
  metrics: Array<{ name: string; value: number; unit: string }>;
  evidenceSummaries: string[];
  limitations: string[];
}

interface Envelope<T> { code: number; message: string; request_id: string; data: T }

export class EvaluationApiError extends Error {
  constructor(readonly code: number, message: string, readonly requestId: string) {
    super(message); this.name = 'EvaluationApiError';
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const session = getPanelSession();
  const response = await fetch(`/api/v1/evaluation/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session ? { 'X-Tdai-Service-Id': session.instanceId, 'X-Tdai-User-Key': session.userKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const envelope = await response.json() as Envelope<T>;
  if (!response.ok || envelope.code !== 0) throw new EvaluationApiError(envelope.code || response.status, envelope.message || 'EVALUATION_REQUEST_FAILED', envelope.request_id || '');
  return envelope.data;
}

export const evaluationApi = {
  list: (teamId: string, query: { keyword?: string; resultLabel?: EvaluationResultLabel }) =>
    post<{ items: EvaluationListItem[]; total: number }>('list', { team_id: teamId, keyword: query.keyword, result_label: query.resultLabel }),
  get: (teamId: string, evaluationId: string) =>
    post<EvaluationDetail>('get', { team_id: teamId, evaluation_id: evaluationId }),
};
