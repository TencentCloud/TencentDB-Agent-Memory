/**
 * Startup hook: ensure each instance has a knowledge-service LLM binding in KS.
 *
 * Design 2026-07-07-009 (方案 A'). TMC 的 `metadata-instances.json` 是 source of truth。
 * 对每个 TMC 实例，查 KS 当前状态，决定动作：
 *   1. 调 KS `/llm-binding/list` 一次拿到所有 binding 缓存成 Map。
 *   2. 对每个 TMC 实例：
 *      - KS 已有可用 key（has_api_key=true）→ 不碰 Gateway，只调 `/set` 更新 proxy_base_url
 *        （不传 api_key，KS 保留原值）。地址没变也调，保持简单。
 *      - KS 无可用 key → 走 Gateway user/list + user/create 或 user-key/create 流程，
 *        push `/set` 带新 key。
 *
 * 这样避免每次 Panel 重启都去 Gateway mint 新 key（受 active key 上限 20 约束）。
 *
 * Best-effort: any per-instance failure is logged and skipped (never blocks startup).
 */

import type { Logger } from '../infra/logger.js';
import type { InstanceEntry } from '../config/instance-registry.js';
import { executeMetaFetch } from '../kernel/transport-fetch.js';
import type { MetaEnvelope } from '../kernel/envelope.js';

/** Fixed username of the per-instance hidden billing user for wiki LLM usage. */
export const KNOWLEDGE_SERVICE_USERNAME = 'knowledge-service';

export interface KnowledgeLlmBindingOptions {
  /** KS base URL (no /v3 suffix), e.g. http://127.0.0.1:8421. */
  knowledgeBaseUrl: string;
  /** KS Bearer token (may be empty when KS trusts the internal network). */
  knowledgeAuthToken: string;
  /** Context proxy root, e.g. http://127.0.0.1:8096. */
  proxyBaseUrl: string;
  /** Kernel call timeout (ms). */
  timeoutMs: number;
}

type EnsureOutcome = 'skipped' | 'bound' | 'error';

/** KS /llm-binding/list 返回的单条 binding 快照（不含 api_key 明文）。 */
interface KsBindingSnapshot {
  service_id: string;
  mode: string;
  proxy_base_url: string | null;
  base_url: string | null;
  has_api_key: boolean;
  enabled: boolean;
}

interface KsEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

async function ksPost<T>(
  opts: KnowledgeLlmBindingOptions,
  path: string,
  serviceId: string,
  body: unknown,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // /list 不需要 service-id 头；其他路径需要
    if (serviceId) headers['x-tdai-service-id'] = serviceId;
    if (opts.knowledgeAuthToken) headers.Authorization = `Bearer ${opts.knowledgeAuthToken}`;
    const resp = await fetch(`${opts.knowledgeBaseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    const json = (await resp.json().catch(() => null)) as KsEnvelope<T> | null;
    if (!resp.ok || !json || (json.code !== undefined && json.code !== 0)) {
      throw new Error(`KS ${path} failed (http ${resp.status}, code ${json?.code}): ${json?.message ?? ''}`);
    }
    return (json.data ?? {}) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** One instance: ensure the binding exists (create/mint/push as needed). */
export async function ensureKnowledgeLlmBinding(
  instance: InstanceEntry,
  opts: KnowledgeLlmBindingOptions,
  logger: Logger,
  ksBindings: Map<string, KsBindingSnapshot>,
): Promise<EnsureOutcome> {
  const serviceId = instance.instance_id;
  const cached = ksBindings.get(serviceId);

  // 场景 A: KS 已有可用 key → 不碰 Gateway，只更新 proxy_base_url（KS 保留原 key）
  if (cached?.has_api_key) {
    await ksPost(opts, '/v3/internal/llm-binding/set', serviceId, {
      mode: 'proxy',
      proxy_base_url: opts.proxyBaseUrl,
      enabled: true,
      // 不传 api_key → KS 保留原值
    });
    logger.info('knowledge llm-binding refreshed (key retained)', { instanceId: serviceId });
    return 'bound';
  }

  // 场景 B: KS 无可用 key → 需要 Gateway user + key 流程
  const metaCfg = {
    endpoint: instance.gateway_endpoint,
    apiKey: instance.api_key,
    serviceId,
    userKey: instance.api_key,
    timeoutMs: opts.timeoutMs,
    logger,
  };

  let userKey: string;

  // Try to find existing knowledge-service user via user/list
  const listEnv = await executeMetaFetch<MetaEnvelope<{ items?: Array<{ user_id: string; username: string }> }>>(
    metaCfg, '/v3/meta/user/list', { username: KNOWLEDGE_SERVICE_USERNAME, limit: 10, offset: 0 }, 'envelope',
  );
  const existing = listEnv.code === 0
    ? (listEnv.data as { items?: Array<{ user_id: string; username: string }> })?.items?.find(
        (u) => u.username === KNOWLEDGE_SERVICE_USERNAME,
      )
    : undefined;

  if (!existing) {
    const createEnv = await executeMetaFetch<MetaEnvelope<{ user_id: string; default_user_key: string }>>(
      // 传确定性 user_id = username，让 proxy systemUsers 白名单能按稳定 user_id 命中
      // （一条 config 通吃所有实例，无需知道随机 usr-xxx）。
      metaCfg, '/v3/meta/user/create', { username: KNOWLEDGE_SERVICE_USERNAME, user_id: KNOWLEDGE_SERVICE_USERNAME }, 'envelope',
    );
    if (createEnv.code !== 0) throw new Error(`user/create failed: ${createEnv.message}`);
    const data = createEnv.data as { user_id: string; default_user_key: string };
    userKey = data.default_user_key;
    logger.info('created knowledge-service user', { instanceId: serviceId, userId: data.user_id });
  } else {
    const mintEnv = await executeMetaFetch<MetaEnvelope<{ key_value: string }>>(
      metaCfg, '/v3/meta/user-key/create', { user_id: existing.user_id, name: 'ks-llm-binding' }, 'envelope',
    );
    if (mintEnv.code !== 0) throw new Error(`user-key/create failed: ${mintEnv.message}`);
    userKey = (mintEnv.data as { key_value: string }).key_value;
    logger.info('minted new key for existing knowledge-service user', {
      instanceId: serviceId,
      userId: existing.user_id,
    });
  }

  // 3. Push to KS (right after mint — show-once).
  await ksPost(opts, '/v3/internal/llm-binding/set', serviceId, {
    mode: 'proxy',
    proxy_base_url: opts.proxyBaseUrl,
    api_key: userKey,
    enabled: true,
  });
  logger.info('pushed knowledge llm-binding to KS (new key)', { instanceId: serviceId });
  return 'bound';
}

/** All instances, best-effort. Never throws. */
export async function ensureKnowledgeLlmBindings(
  instances: InstanceEntry[],
  opts: KnowledgeLlmBindingOptions,
  logger: Logger,
): Promise<void> {
  // 1. 一次性查 KS /llm-binding/list 拿到当前状态缓存
  let ksBindings = new Map<string, KsBindingSnapshot>();
  try {
    const resp = await ksPost<{ items: KsBindingSnapshot[] }>(
      opts, '/v3/internal/llm-binding/list', '', {},
    );
    ksBindings = new Map((resp.items ?? []).map((b) => [b.service_id, b]));
    logger.info('fetched KS llm-binding list', { count: ksBindings.size });
  } catch (err) {
    logger.warn('failed to fetch KS llm-binding list, will mint per-instance', {
      error: err instanceof Error ? err.message : String(err),
    });
    // KS /list 失败时回退：ksBindings 为空 Map，每个实例都走 mint 流程（兼容老 KS）
  }

  // 2. 以 TMC instances 列表为准逐个处理
  for (const instance of instances) {
    try {
      await ensureKnowledgeLlmBinding(instance, opts, logger, ksBindings);
    } catch (err) {
      logger.warn('knowledge llm-binding ensure failed (will rely on manual recovery)', {
        instanceId: instance.instance_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
