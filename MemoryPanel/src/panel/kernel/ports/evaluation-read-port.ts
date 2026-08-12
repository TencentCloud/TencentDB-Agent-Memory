export const EVALUATION_DISCLAIMER =
  '合成控制器参考态，仅验证 Demo 契约与展示链路，不代表真实 Agent 收益、线上效果或平台能力';

export type EvaluationResultLabel = 'POSITIVE' | 'INCONCLUSIVE' | 'NEGATIVE';

export interface EvaluationSemantics {
  evidenceLevel: 'E1';
  liveAgentExecuted: false;
  catxCalled: false;
  externalAuthorityVerified: false;
  e2Status: 'BLOCKED';
  runExposure: 'NOT_PROVEN';
  cardE1BindingHash: null;
  disclaimer: typeof EVALUATION_DISCLAIMER;
}

export interface EvaluationCardProjection {
  projectionType: 'DISPLAY_ONLY';
  cardId: string;
  title: string;
  summary: string;
  tags: string[];
}

export interface EvaluationComparisonArm {
  armId: 'K0P0' | 'K0P1' | 'K1P0' | 'K1P1';
  knowledgeVariant: 'K0' | 'K1';
  flowVariant: 'P0' | 'P1';
  recordedAccepted: boolean;
  sampleCount: number;
}

export interface EvaluationDetail {
  evaluationId: string;
  title: string;
  resultLabel: EvaluationResultLabel;
  generatedAt: string;
  sampleCount: number;
  knowledgeCards: EvaluationCardProjection[];
  comparison: EvaluationComparisonArm[];
  metrics: Array<{ name: string; value: number; unit: string }>;
  evidenceSummaries: string[];
  limitations: string[];
  semantics: EvaluationSemantics;
  bundleVersion: string;
  bundleSha256: string;
  sourceMode: 'RECORDED_FIXTURE';
  tenantScope: 'GLOBAL_SYNTHETIC';
}

export type EvaluationListItem = Pick<
  EvaluationDetail,
  | 'evaluationId'
  | 'title'
  | 'resultLabel'
  | 'generatedAt'
  | 'sampleCount'
  | 'semantics'
  | 'bundleVersion'
  | 'bundleSha256'
  | 'sourceMode'
  | 'tenantScope'
> & { cardTitles: string[] };

export interface EvaluationRequestContext {
  instanceId: string;
  teamId: string;
  actorUserId: string;
  requestId?: string;
}

export interface EvaluationListQuery {
  keyword?: string;
  resultLabel?: EvaluationResultLabel;
}

export interface EvaluationReadPort {
  list(ctx: EvaluationRequestContext, query: EvaluationListQuery): Promise<EvaluationListItem[]>;
  get(ctx: EvaluationRequestContext, evaluationId: string): Promise<EvaluationDetail | null>;
}

export type EvaluationUnavailableReason =
  | 'EVALUATION_DISABLED'
  | 'BUNDLE_MISSING'
  | 'DIGEST_PIN_MISSING'
  | 'DIGEST_MISMATCH'
  | 'SCHEMA_INVALID'
  | 'WHITELIST_VIOLATION';

export class EvaluationUnavailableError extends Error {
  constructor(readonly reason: EvaluationUnavailableReason) {
    super(reason);
    this.name = 'EvaluationUnavailableError';
  }
}
