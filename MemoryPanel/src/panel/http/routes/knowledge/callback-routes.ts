/**
 * /api/v1/knowledge/status-callback —— KS → Panel 状态回调（S2S，无 user-key）。
 *
 * KS ingest/sync 完成后回调。设计 §0.6：
 *   - status=ready + summary → 写内核明细 entity_knowledge（/v3/knowledge/create）；
 *     这是 Proxy 注入的唯一闸门。
 *   - code-graph ready 时再以 owner 身份登记 meta_asset（/v3/meta/asset/create）；
 *     callback 是 S2S 无 user_key，用 code-graph/create 时内存任务表 stash 的
 *     owner_user_key 走 ForCaller 路径（caller===owner）。失败 best-effort，
 *     前端 register-meta 兜底（幂等）。
 *   - status=failed → 不写明细、不写 meta（资源不可注入，UI 读 KS status 显示失败）。
 *
 * 用 payload.service_id 从注册表解析实例凭证（endpoint + api_key）→ 组 S2S 凭证
 * → 取 KS 详情 → POST /v3/knowledge/create。
 *
 * 不挂 validatePanelMetaHeaders（S2S，无浏览器 session header）。
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import type { KernelCredentials, MetaCallContext } from '../../../kernel/types.js';
import { ensureKnowledgeAsset, ASSET_TYPE_CODE_GRAPH } from './common.js';

interface CallbackBody {
  knowledge_id?: string;
  service_id?: string;
  type?: 'wiki' | 'code-graph';
  status?: 'ready' | 'failed';
  summary?: string | null;
  sync_error?: string | null;
  timestamp?: string;
  /** 细粒度 ingest 进度（与终态 status 回调共用 endpoint） */
  event?: 'ingest_progress';
  wiki_id?: string;
  team_id?: string;
  /** 单次 ingest 代际；与 progress / 终态共用，防 clear 后迟到包 */
  run_id?: string;
  progress?: {
    phase?: string;
    total?: number;
    completed?: number;
    failed?: number;
    skipped?: number;
    percent?: number;
  };
}

async function safeJson(c: { req: { text: () => Promise<string> } }): Promise<CallbackBody> {
  try {
    const text = await c.req.text();
    if (!text?.trim()) return {};
    return JSON.parse(text) as CallbackBody;
  } catch {
    return {};
  }
}

function isProgressPhase(p: unknown): p is 'extracting' | 'merging' | 'indexing' {
  return p === 'extracting' || p === 'merging' || p === 'indexing';
}

/**
 * code-graph ready 后用内存任务表里 stash 的 owner key 注册 meta asset。
 * callback 是 S2S、无 user_key，靠 create 时记录的 owner_user_key 以 owner
 * 身份打 /v3/meta/asset/create（ForCaller 路由要求 caller===owner）。
 * best-effort：失败只 log，前端 register-meta 会兜底（幂等）。
 */
async function registerCodeGraphAsset(
  deps: PanelDeps,
  log: PanelDeps['logger'],
  knowledgeId: string,
  detail: { code_graph_id: string; team_id: string; repo_name: string; repo_url: string; service_url: string | null },
  entry: { instance_id: string; gateway_endpoint: string; api_key: string },
): Promise<void> {
  const task = deps.knowledgeTaskRegistry.peek(knowledgeId);
  if (!task) {
    // 内存里没有（进程重启 / 非 panel 创建路径）——交给前端 register-meta 兜底
    log.info('[knowledge-callback] no in-memory task stash; skip S2S asset register (frontend fallback)', {
      knowledge_id: knowledgeId,
    });
    return;
  }
  log.info('[knowledge-callback] found in-memory task stash; registering meta asset as owner', {
    knowledge_id: knowledgeId, owner_user_id: task.owner_user_id, team_id: task.team_id,
  });
  const ownerCtx: MetaCallContext = {
    instanceId: entry.instance_id,
    gatewayEndpoint: entry.gateway_endpoint,
    gatewayApiKey: entry.api_key,
    userKey: task.owner_user_key,
    reqId: `cb-${knowledgeId}`,
  };
  try {
    const reg = await ensureKnowledgeAsset(deps, ownerCtx, {
      assetId: detail.code_graph_id,
      teamId: detail.team_id,
      assetType: ASSET_TYPE_CODE_GRAPH,
      name: detail.repo_name || detail.repo_url,
      ownerUserId: task.owner_user_id,
      serviceUrl: detail.service_url,
    });
    if (reg.ok) {
      deps.knowledgeTaskRegistry.take(knowledgeId);
      log.info('[knowledge-callback] meta asset registered (or already present); task cleared', {
        knowledge_id: knowledgeId, asset_id: detail.code_graph_id,
      });
    } else {
      log.error(`[knowledge-callback] asset register rejected for ${knowledgeId}: code=${(reg.env as { code?: number }).code}`);
    }
  } catch (err) {
    log.error(`[knowledge-callback] asset register error for ${knowledgeId}: ${(err as Error).message}`);
  }
}

export function registerKnowledgeCallbackRoutes(api: Hono, deps: PanelDeps): void {
  const log = deps.logger;

  api.post('/knowledge/status-callback', async (c) => {
    const body = await safeJson(c);

    // ── ingest 细粒度进度（非终态）──
    if (body.event === 'ingest_progress') {
      const wikiId = body.wiki_id?.trim();
      const p = body.progress;
      if (
        !wikiId ||
        !p ||
        !isProgressPhase(p.phase) ||
        typeof p.total !== 'number' ||
        typeof p.completed !== 'number' ||
        typeof p.failed !== 'number' ||
        typeof p.skipped !== 'number' ||
        typeof p.percent !== 'number'
      ) {
        log.warn('[knowledge-callback] ingest_progress rejected: bad payload', {
          wiki_id: body.wiki_id, has_progress: !!body.progress,
        });
        return c.json({ code: 400, message: 'wiki_id and progress fields are required', request_id: '', data: null }, 400);
      }
      deps.ingestProgressStore.update(wikiId, {
        phase: p.phase,
        total: p.total,
        completed: p.completed,
        failed: p.failed,
        skipped: p.skipped,
        percent: p.percent,
      }, body.run_id);
      log.info('[knowledge-callback] ingest_progress stored', {
        wiki_id: wikiId, phase: p.phase, percent: p.percent, run_id: body.run_id,
      });
      return c.json({ code: 0, message: 'ok', request_id: '', data: null });
    }

    if (!body.knowledge_id || !body.type || !body.status) {
      log.warn('[knowledge-callback] rejected: missing fields', {
        knowledge_id: body.knowledge_id, type: body.type, status: body.status,
      });
      return c.json({ code: 400, message: 'knowledge_id, type, status are required', request_id: '', data: null }, 400);
    }
    log.info('[knowledge-callback] received', {
      knowledge_id: body.knowledge_id,
      type: body.type,
      status: body.status,
      service_id: body.service_id,
      has_summary: !!body.summary,
      run_id: body.run_id,
    });

    // 终态：清掉细粒度进度，并记录 run_id 以拒绝该代际迟到包
    if (body.type === 'wiki' && (body.status === 'ready' || body.status === 'failed')) {
      deps.ingestProgressStore.clear(body.knowledge_id, body.run_id);
    }

    // ready 即写明细（即使无 summary 也推——用户觉得有问题可自行删除）
    if (body.status === 'ready') {
      if (!body.summary) {
        log.warn('[knowledge-callback] ready but no summary; pushing kernel entity anyway', { knowledge_id: body.knowledge_id });
      }
      try {
        const serviceId = body.service_id?.trim();
        if (!serviceId) {
          log.error(`[knowledge-callback] ${body.knowledge_id}: missing service_id, cannot resolve instance; skip`);
          return c.json({ code: 0, message: 'ok', request_id: '', data: null });
        }
        const entry = deps.instanceRegistry.resolve(serviceId); // 抛 → 下方 catch
        const cred: KernelCredentials = {
          endpoint: entry.gateway_endpoint,
          apiKey: entry.api_key,
          instanceId: entry.instance_id,
          timeoutMs: deps.config.metadataRemoteTimeoutMs,
        };
        const kc = deps.knowledgeClientFactory(serviceId);

        if (body.type === 'wiki') {
          const detail = await kc.wikiGet(body.knowledge_id);
          if (!detail?.service_url) {
            log.error(`[knowledge-callback] wiki ${body.knowledge_id}: null service_url; skip kernel detail sync`);
          } else {
            log.info('[knowledge-callback] wiki → writing kernel entity', {
              knowledge_id: detail.wiki_id, team_id: detail.team_id, owner: detail.owner_user_id,
              has_summary: !!body.summary,
            });
            await deps.kernelHttp.postEnvelope('/v3/knowledge/create', {
              knowledge_id: detail.wiki_id,
              type: 'wiki',
              service_url: detail.service_url,
              name: detail.name,
              summary: body.summary ?? '',
              team_id: detail.team_id,
              user_id: detail.owner_user_id,
            }, cred);
            log.info('[knowledge-callback] wiki → kernel entity written', { knowledge_id: detail.wiki_id });
            // wiki 的 meta 资产在创建时已注册，callback 不再重复注册。
          }
        } else {
          const detail = await kc.codeGraphGet(body.knowledge_id);
          log.info('[knowledge-callback] code-graph detail fetched from KS', {
            knowledge_id: detail?.code_graph_id, status: detail?.status,
            has_service_url: !!detail?.service_url, owner: detail?.owner_user_id,
          });
          if (!detail?.service_url) {
            log.error(`[knowledge-callback] code-graph ${body.knowledge_id}: null service_url; skip kernel detail sync`);
          } else {
            log.info('[knowledge-callback] code-graph → writing kernel entity', {
              knowledge_id: detail.code_graph_id, team_id: detail.team_id, owner: detail.owner_user_id,
              has_summary: !!body.summary,
            });
            await deps.kernelHttp.postEnvelope('/v3/knowledge/create', {
              knowledge_id: detail.code_graph_id,
              type: 'code-graph',
              service_url: detail.service_url,
              name: detail.repo_name || detail.repo_url,
              summary: body.summary ?? '',
              team_id: detail.team_id,
              user_id: detail.owner_user_id,
              repo_url: detail.repo_url,
              branch: detail.branch,
            }, cred);
            log.info('[knowledge-callback] code-graph → kernel entity written', { knowledge_id: detail.code_graph_id });
            // 注册 meta asset（主力路径）：用 create 时 stash 的 owner key 以 owner 身份
            // 打 /v3/meta/asset/create。callback 本身是 S2S 无 user_key，靠内存任务表补。
            // 失败 best-effort——前端 register-meta 会兜底（幂等）。
            await registerCodeGraphAsset(deps, log, body.knowledge_id, detail, entry);
          }
        }
      } catch (err) {
        log.error(`[knowledge-callback] kernel detail sync error for ${body.knowledge_id}: ${(err as Error).message}`);
      }
    } else if (body.status === 'failed') {
      log.info('[knowledge-callback] failed; not writing entity/meta (UI reads KS status)', { knowledge_id: body.knowledge_id, sync_error: body.sync_error });
    }

    // TODO: WebSocket push to frontend for real-time UI update
    log.info('[knowledge-callback] done', { knowledge_id: body.knowledge_id, status: body.status });
    return c.json({ code: 0, message: 'ok', request_id: '', data: null });
  });
}
