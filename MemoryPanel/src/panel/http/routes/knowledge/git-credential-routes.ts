import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PanelDeps } from '../../../panel-deps.js';
import type { GitSecret } from '../../../kernel/ports/knowledge-client-port.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError } from '../../envelope.js';
import { buildCtx, readJson, str, requireTeamMember, runKs } from './common.js';

export function registerGitCredentialRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);
  for (const action of ['list', 'put', 'delete', 'test', 'host-key', 'trust-host'] as const) {
    api.post(`/knowledge/source-credential/${action}`, mw, bodyLimit({ maxSize: 160 * 1024 }), async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const teamId = str(body, 'team_id');
      if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
      const gate = await requireTeamMember(deps, c, ctx, teamId);
      if ('error' in gate) return gate.error;
      const kc = deps.knowledgeClientFactory(ctx.instanceId);
      // Identity is always derived from the authenticated caller, never the body.
      if (action === 'list') return runKs(c, () => kc.gitCredentialList(teamId, gate.userId));
      const id = str(body, 'credential_id');
      if (action === 'put') {
        return runKs(c, () => kc.gitCredentialPut(teamId, gate.userId, {
          credential_id: id ?? undefined, name: str(body, 'name') ?? '',
          hostname: str(body, 'hostname') ?? undefined,
          secret: body.secret as GitSecret,
        }));
      }
      if (!id) return respondControlError(c, 400, 'MISSING_CREDENTIAL_ID');
      if (action === 'delete') return runKs(c, () => kc.gitCredentialDelete(teamId, gate.userId, id));
      if (action === 'host-key') return runKs(c, () => kc.gitCredentialHostKey(teamId, gate.userId, id, str(body, 'repo_url') ?? '', body.refresh === true));
      if (action === 'trust-host') {
        if (body.previous_known_hosts !== null && typeof body.previous_known_hosts !== 'string') return respondControlError(c, 400, 'MISSING_PREVIOUS_HOST_TRUST');
        return runKs(c, () => kc.gitCredentialTrustHost(teamId, gate.userId, id, str(body, 'repo_url') ?? '', str(body, 'known_hosts') ?? '', body.previous_known_hosts as string | null));
      }
      return runKs(c, () => kc.gitCredentialTest(teamId, gate.userId, id, str(body, 'repo_url') ?? ''));
    });
  }
}
