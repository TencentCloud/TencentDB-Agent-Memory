import type { Hono } from 'hono';
import { z } from 'zod';
import type { PanelDeps } from '../../panel-deps.js';
import { UPSTREAM_CLIENTS } from '../../api/upstream-clients.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { buildCtx, isCallerSystemAdmin, okEnvelope } from './knowledge/common.js';
import { toKernelCredentials } from '../../kernel/types.js';
import { respondControlError } from '../envelope.js';

const input = z.object({
  agent_source: z.string(),
  base_url: z.string().trim().url().max(2048),
  api_key: z.string().trim().min(1).max(8192).refine((key) => !key.startsWith('sk-mem-')).optional(),
  model_id: z.string().trim().min(1).max(200),
});

export function registerUpstreamTestRoute(api: Hono, deps: PanelDeps): void {
  // Before /meta/*: test a draft without changing stored configuration.
  api.post('/meta/instance-upstream/test', validatePanelMetaHeaders(deps), async (c) => {
    if (!(await isCallerSystemAdmin(deps, buildCtx(c)))) {
      return respondControlError(c, 403, 'permission_denied');
    }
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return respondControlError(c, 400, 'INVALID_PARAM');
    const draft = parsed.data;
    const client = UPSTREAM_CLIENTS.find((item) => item.id === draft.agent_source);
    const url = new URL(draft.base_url);
    // Local/private model servers are intentional administrator-configured targets.
    if (!client || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\/(messages|responses|chat\/completions)\/?$/.test(url.pathname)) {
      return respondControlError(c, 400, 'INVALID_PARAM');
    }
    if (draft.api_key === undefined) {
      const env = await deps.kernelHttp.postEnvelope<{ items: { agent_source: string; base_url: string; api_key: string }[] }>(
        '/v3/internal/meta/instance-upstream/list', { type: 'conversation' },
        toKernelCredentials(buildCtx(c), { timeoutMs: 3000 }),
      );
      const saved = env.code === 0 ? env.data?.items.find((item) => item.agent_source === draft.agent_source) : undefined;
      if (!saved?.api_key || saved.api_key.startsWith('sk-mem-')) {
        return respondControlError(c, 400, 'INVALID_PARAM');
      }
      draft.api_key = saved.api_key;
    }
    const results: { protocol: string; status: string; httpStatus?: number }[] = [];
    for (const protocol of client.protocols) {
      try {
        const suffix = protocol === 'anthropic' ? '/messages' : protocol === 'responses' ? '/responses' : '/chat/completions';
        const base = draft.base_url.replace(/\/+$/, '');
        const response = await fetch(base + suffix, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
          // Never forward Panel/Memory credentials to the provider.
          headers: { 'content-type': 'application/json', ...(protocol === 'anthropic'
            ? { 'x-api-key': draft.api_key, 'anthropic-version': '2023-06-01' }
            : { authorization: `Bearer ${draft.api_key}` }) },
          body: JSON.stringify({ model: draft.model_id, stream: false, ...(protocol === 'responses'
            ? { max_output_tokens: 256, input: 'Reply with OK.' }
            : { max_tokens: 256, messages: [{ role: 'user', content: 'Reply with OK.' }] }) }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          results.push({ protocol, status: 'http_error', httpStatus: response.status });
          continue;
        }
        const body = await response.json() as Record<string, any>;
        const text = protocol === 'anthropic' ? body.content?.some((b: any) => b.type === 'text' && typeof b.text === 'string' && b.text.trim())
          : protocol === 'chat' ? body.choices?.some((b: any) => b.message?.role === 'assistant' && typeof b.message.content === 'string' && b.message.content.trim())
          : body.output?.some((b: any) => b.type === 'message' && b.role === 'assistant' && b.content?.some((v: any) => v.type === 'output_text' && typeof v.text === 'string' && v.text.trim()));
        const limited = body.stop_reason === 'max_tokens' || body.choices?.some((b: any) => b.finish_reason === 'length') || body.incomplete_details?.reason === 'max_output_tokens';
        results.push({ protocol, status: text ? 'ready' : limited ? 'output_limited' : 'invalid_response' });
      } catch {
        results.push({ protocol, status: 'unreachable' });
      }
    }
    return c.json(okEnvelope(c, { results }));
  });
}
