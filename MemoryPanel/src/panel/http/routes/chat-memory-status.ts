import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { toKernelCredentials } from '../../kernel/types.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import {
  buildCtx,
  okEnvelope,
  readJson,
  resolveCallerUserId,
  str,
} from './knowledge/common.js';
import {
  authorizeChatMemoryRead,
  parseChatMemoryAssetId,
  type AssetRaw,
} from './chat-memory.js';

type LayerName = 'L0_messages' | 'L1' | 'L2' | 'L3';

interface LayerCounts {
  L0_messages: number | null;
  L1: number | null;
  L2: number | null;
  L3: number | null;
}

export function registerChatMemoryStatusRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/chat-memory/status', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const blockId = str(await readJson(c), 'block_id');
    if (!blockId) return respondControlError(c, 400, 'MISSING_BLOCK_ID');

    const userId = await resolveCallerUserId(deps, ctx);
    if (!userId) return respondControlError(c, 401, 'INVALID_USER_KEY');
    const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: blockId }, ctx);
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, 'BLOCK_NOT_FOUND');
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (asset.asset_type !== 'chat_memory') return respondControlError(c, 400, 'NOT_CHAT_MEMORY');
    if (!(await authorizeChatMemoryRead(deps, ctx, asset, userId, blockId))) {
      return respondControlError(c, 403, 'ASSET_NOT_ACCESSIBLE');
    }

    const parsed = parseChatMemoryAssetId(blockId);
    if (!parsed) {
      return respondEnvelope(c, okEnvelope(c, {
        block_id: blockId,
        checked_at: new Date().toISOString(),
        availability: 'not_applicable',
        layer_counts: { L0_messages: null, L1: null, L2: null, L3: null } satisfies LayerCounts,
        unavailable_layers: [] as LayerName[],
      }));
    }

    const cred = toKernelCredentials(ctx, { timeoutMs: 15_000 });
    const idFields = {
      team_id: parsed.teamId,
      agent_id: parsed.agentId,
      user_id: asset.owner_user_id,
      session_id: 'default',
    };
    const { session_id: _sessionId, ...l0Fields } = idFields;
    void _sessionId;
    const count = async (path: string, body: Record<string, unknown>): Promise<number> => {
      const env = await deps.kernelHttp.postEnvelope<{ total?: number }>(path, body, cred);
      if (env.code !== 0) throw env;
      if (typeof env.data?.total !== 'number') throw new Error(`invalid count response: ${path}`);
      return env.data.total;
    };
    const calls: Array<[LayerName, Promise<number>]> = [
      ['L0_messages', count('/v3/conversation/count', l0Fields)],
      ['L1', count('/v3/atomic/count', idFields)],
      ['L2', count('/v3/scenario/count', idFields)],
      ['L3', count('/v3/core/count', idFields)],
    ];
    const settled = await Promise.allSettled(calls.map(([, promise]) => promise));
    const counts: LayerCounts = { L0_messages: null, L1: null, L2: null, L3: null };
    const unavailable: LayerName[] = [];
    settled.forEach((result, index) => {
      const layer = calls[index]?.[0];
      if (!layer) return;
      if (result.status === 'fulfilled') counts[layer] = result.value;
      else unavailable.push(layer);
    });
    const successful = 4 - unavailable.length;
    return respondEnvelope(c, okEnvelope(c, {
      block_id: blockId,
      checked_at: new Date().toISOString(),
      availability: successful === 4 ? 'complete' : successful === 0 ? 'unavailable' : 'partial',
      layer_counts: counts,
      unavailable_layers: unavailable,
    }));
  });
}
