/**
 * routes/upstream.ts — 面板「模型管理」菜单的连通性测试。
 *
 * POST /upstream/test
 *   body: { base_url, api_key?, model_id?, protocol? }
 *
 * 由面板后端直接向上游发一个最小请求（16 tokens 的 hello），把成功/失败与
 * **上游返回的报错原文**如实带回前端，方便用户照着改配置。
 *
 * 与「新增/修改上游分组」的读写不同：分组 CRUD 走内核既有接口
 * （/v3/meta/instance-upstream/*，见 api/meta-actions.ts 白名单），本文件只负责"测"。
 *
 * ⚠️ 安全提示：本接口会用面板进程的网络身份访问用户填写的任意 URL（SSRF 面）。
 *    部署于内网运维场景，仅限已登录面板的管理员调用（挂 validatePanelMetaHeaders）。
 */

import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';

const TEST_TIMEOUT_MS = 20000;

type Protocol = 'openai-chat' | 'anthropic' | 'openai-responses';

/**
 * 拼测试 URL —— 与 Proxy 侧 joinUrl 语义对齐：
 * base 已以 /v1 结尾则不再补 /v1，避免 double-append。
 */
function buildTestUrl(baseUrl: string, protocol: Protocol): string {
  const base = baseUrl.replace(/\/+$/, '');
  const hasV1 = /\/v1$/i.test(base);
  if (protocol === 'anthropic') {
    return `${base}${hasV1 ? '' : '/v1'}/messages`;
  }
  if (protocol === 'openai-responses') {
    return `${base}${hasV1 ? '' : '/v1'}/responses`;
  }
  return `${base}${hasV1 ? '' : '/v1'}/chat/completions`;
}

function buildBody(protocol: Protocol, modelId: string): Record<string, unknown> {
  if (protocol === 'anthropic') {
    return {
      model: modelId,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    };
  }
  if (protocol === 'openai-responses') {
    return {
      model: modelId,
      max_output_tokens: 16,
      input: 'hi',
    };
  }
  return {
    model: modelId,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  };
}

function buildHeaders(protocol: Protocol, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!apiKey) return headers;
  if (protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

const MODELS_TIMEOUT_MS = 15000;

export function registerUpstreamRoutes(api: Hono, deps: PanelDeps): void {
  // P1: 拉取供应商模型列表（OpenAI / Anthropic 均为 GET {base}/models → {data:[{id}]}）
  api.post('/upstream/models', validatePanelMetaHeaders(deps), async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : '';
    if (!baseUrl) return respondControlError(c, 400, 'MISSING_BASE_URL');
    if (!/^https?:\/\//i.test(baseUrl)) {
      return respondControlError(c, 400, 'INVALID_BASE_URL: 必须以 http:// 或 https:// 开头');
    }
    const apiKey = typeof body.api_key === 'string' ? body.api_key : '';
    const rawProtocol = typeof body.protocol === 'string' ? body.protocol : 'openai-chat';
    const protocol: Protocol =
      rawProtocol === 'anthropic' || rawProtocol === 'openai-responses'
        ? rawProtocol
        : 'openai-chat';

    const base = baseUrl.replace(/\/+$/, '');
    const hasV1 = /\/v1$/i.test(base);
    const url = `${base}${hasV1 ? '' : '/v1'}/models`;

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(protocol, apiKey),
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
      const text = await resp.text();
      if (!resp.ok) {
        return respondEnvelope(c, {
          code: 0, message: 'ok', request_id: c.get('reqId') ?? '',
          data: { ok: false, models: [], error: `HTTP ${resp.status}: ${text.slice(0, 300)}` },
        });
      }
      const parsed = JSON.parse(text) as { data?: Array<{ id?: string }> };
      const models = (parsed.data ?? [])
        .map((m) => (typeof m.id === 'string' ? m.id : ''))
        .filter((id): id is string => !!id)
        .sort();
      return respondEnvelope(c, {
        code: 0, message: 'ok', request_id: c.get('reqId') ?? '',
        data: { ok: true, models },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return respondEnvelope(c, {
        code: 0, message: 'ok', request_id: c.get('reqId') ?? '',
        data: { ok: false, models: [], error: message },
      });
    }
  });

  api.post('/upstream/test', validatePanelMetaHeaders(deps), async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : '';
    if (!baseUrl) {
      return respondControlError(c, 400, 'MISSING_BASE_URL');
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      return respondControlError(c, 400, 'INVALID_BASE_URL: 必须以 http:// 或 https:// 开头');
    }

    const apiKey = typeof body.api_key === 'string' ? body.api_key : '';
    const modelId = typeof body.model_id === 'string' && body.model_id ? body.model_id : 'gpt-4o-mini';
    const rawProtocol = typeof body.protocol === 'string' ? body.protocol : 'openai-chat';
    const protocol: Protocol =
      rawProtocol === 'anthropic' || rawProtocol === 'openai-responses'
        ? rawProtocol
        : 'openai-chat';

    const url = buildTestUrl(baseUrl, protocol);
    const started = Date.now();
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(protocol, apiKey),
        body: JSON.stringify(buildBody(protocol, modelId)),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      const latencyMs = Date.now() - started;
      const text = await resp.text();
      let preview = text.slice(0, 600);
      let modelEcho = '';
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        modelEcho = typeof parsed.model === 'string' ? parsed.model : '';
        const errObj = parsed.error as Record<string, unknown> | undefined;
        if (errObj && typeof errObj.message === 'string') {
          preview = errObj.message.slice(0, 600);
        }
      } catch {
        /* 非 JSON 响应：直接回显原文片段 */
      }
      return respondEnvelope(c, {
        code: 0,
        message: 'ok',
        request_id: c.get('reqId') ?? '',
        data: {
          ok: resp.ok,
          status: resp.status,
          statusText: resp.statusText,
          latencyMs,
          requestUrl: url,
          modelEcho,
          responsePreview: preview,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.warn('upstream connectivity test failed', { url, error: message });
      return respondEnvelope(c, {
        code: 0,
        message: 'ok',
        request_id: c.get('reqId') ?? '',
        data: {
          ok: false,
          status: 0,
          statusText: 'FETCH_FAILED',
          latencyMs: Date.now() - started,
          requestUrl: url,
          modelEcho: '',
          responsePreview: message,
        },
      });
    }
  });
}
