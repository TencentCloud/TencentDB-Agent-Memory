import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { EvaluationUnavailableError, type EvaluationResultLabel } from '../../../kernel/ports/evaluation-read-port.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import { buildCtx, okEnvelope, readJson, requireTeamMember, str } from '../knowledge/common.js';

function resultLabel(body: Record<string, unknown>): EvaluationResultLabel | undefined | null {
  const value = body.result_label;
  if (value === undefined || value === null || value === '') return undefined;
  return value === 'POSITIVE' || value === 'INCONCLUSIVE' || value === 'NEGATIVE' ? value : null;
}

function unavailable(c: Parameters<typeof respondControlError>[0], error: unknown): Response {
  if (error instanceof EvaluationUnavailableError) return respondControlError(c, 503, error.reason);
  throw error;
}

export function registerEvaluationRoutes(api: Hono, deps: PanelDeps): void {
  const middleware = validatePanelMetaHeaders(deps);
  api.post('/evaluation/list', middleware, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const label = resultLabel(body);
    if (label === null) return respondControlError(c, 400, 'INVALID_RESULT_LABEL');
    try {
      const items = await deps.evaluationRead.list(
        { instanceId: ctx.instanceId, teamId, actorUserId: gate.userId, requestId: ctx.reqId },
        { keyword: str(body, 'keyword') ?? undefined, resultLabel: label },
      );
      return respondEnvelope(c, okEnvelope(c, { items, total: items.length }));
    } catch (error) { return unavailable(c, error); }
  });

  api.post('/evaluation/get', middleware, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const evaluationId = str(body, 'evaluation_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!evaluationId) return respondControlError(c, 400, 'MISSING_EVALUATION_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    try {
      const item = await deps.evaluationRead.get(
        { instanceId: ctx.instanceId, teamId, actorUserId: gate.userId, requestId: ctx.reqId }, evaluationId,
      );
      if (!item) return respondControlError(c, 404, 'EVALUATION_NOT_FOUND');
      return respondEnvelope(c, okEnvelope(c, item));
    } catch (error) { return unavailable(c, error); }
  });
}
