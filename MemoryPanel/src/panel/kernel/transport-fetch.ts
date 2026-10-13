/**
 * 记忆内核 v3 元数据 HTTP fetch（Panel 专用）。
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '../infra/logger.js';
import type { MetaEnvelope } from './envelope.js';
import { mapHttpStatusFromEnvelopeCode } from './envelope.js';
import { META_HEADER_REQUEST_ID, META_HEADER_SERVICE_ID, META_HEADER_USER_KEY } from './headers.js';

export { mapHttpStatusFromEnvelopeCode };

/** 内核 HTTP 调用失败（网络/超时/无效信封）。 */
export class KernelFetchError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'KernelFetchError';
  }

  get httpStatus(): number {
    return mapHttpStatusFromEnvelopeCode(this.code);
  }
}

export interface MetaFetchConfig {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  userKey?: string;
  timeoutMs?: number;
  logger?: Logger;
  /** 透传为 x-request-id；缺省则生成 UUID。 */
  requestId?: string;
  /**
   * 额外请求头（如 task-source 的令牌注入）。
   *
   * 注意：这些头**不参与日志**（logRemoteMeta 仅记录操作和状态），
   * 因此绝不把敏感值放这里后又手工拼进日志字段。
   */
  extraHeaders?: Record<string, string>;
}

interface RawEnvelope<T> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
}

function logRemoteMeta(
  logger: Logger | undefined,
  phase: 'request' | 'response' | 'error',
  requestId: string,
  fields: Record<string, unknown>,
): void {
  if (!logger) return;
  const msg = `[${requestId}] api.remote.${phase}`;
  if (phase === 'error') {
    logger.warn(msg, fields);
    return;
  }
  logger.info(msg, fields);
}

/**
 * 请求记忆内核路径，返回完整信封。
 * - mode=envelope：业务 code≠0 不抛错（透明代理用）
 * - mode=data：code≠0 抛 KernelFetchError
 * - method：默认 POST；GET 用于 /v3/analytics/config、spaces 等只读端点（不携带 body）
 */
export async function executeMetaFetch<T>(
  cfg: MetaFetchConfig,
  path: string,
  body: unknown,
  mode: 'data' | 'envelope',
  method: 'POST' | 'GET' = 'POST',
): Promise<T> {
  const base = cfg.endpoint.replace(/\/+$/, '');
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const log = cfg.logger;
  const startedAt = Date.now();
  const reqId = cfg.requestId ?? randomUUID();
  logRemoteMeta(log, 'request', reqId, {
    path,
    serviceId: cfg.serviceId,
    request_id: reqId,
    requestPayloadOmitted: true,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [META_HEADER_SERVICE_ID]: cfg.serviceId,
      [META_HEADER_REQUEST_ID]: reqId,
    };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (cfg.userKey) headers[META_HEADER_USER_KEY] = cfg.userKey;
    if (cfg.extraHeaders) Object.assign(headers, cfg.extraHeaders);
    const resp = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: ctrl.signal,
      redirect: 'error',
    });
    const env = (await resp.json().catch(() => null)) as RawEnvelope<unknown> | null;
    if (!env || typeof env.code !== 'number') {
      const err = new KernelFetchError(502, `invalid envelope from ${path} (http ${resp.status})`);
      logRemoteMeta(log, 'error', reqId, {
        path,
        request_id: reqId,
        durationMs: Date.now() - startedAt,
        httpStatus: resp.status,
        error: err.message,
      });
      throw err;
    }
    const envelope: MetaEnvelope<unknown> = {
      code: env.code,
      message: env.message ?? (env.code === 0 ? 'ok' : `error ${env.code}`),
      request_id: env.request_id ?? reqId,
      data: (env.data ?? {}) as unknown,
    };
    if (mode === 'envelope') {
      if (env.code !== 0) {
        logRemoteMeta(log, 'error', envelope.request_id, {
          path,
          request_id: envelope.request_id,
          durationMs: Date.now() - startedAt,
          envelopeCode: env.code,
          responsePayloadOmitted: true,
        });
      } else {
        logRemoteMeta(log, 'response', envelope.request_id, {
          path,
          durationMs: Date.now() - startedAt,
          request_id: envelope.request_id,
          responsePayloadOmitted: true,
        });
      }
      return envelope as T;
    }
    if (env.code !== 0) {
      const err = new KernelFetchError(env.code, envelope.message);
      logRemoteMeta(log, 'error', envelope.request_id, {
        path,
        request_id: envelope.request_id,
        durationMs: Date.now() - startedAt,
        envelopeCode: env.code,
        responsePayloadOmitted: true,
      });
      throw err;
    }
    logRemoteMeta(log, 'response', envelope.request_id, {
      path,
      durationMs: Date.now() - startedAt,
      request_id: envelope.request_id,
      responsePayloadOmitted: true,
    });
    return (env.data ?? {}) as T;
  } catch (err) {
    if (err instanceof KernelFetchError) throw err;
    const isTimeout = (err as { name?: string }).name === 'AbortError';
    const message = isTimeout
      ? `remote metadata timeout at ${path}`
      : `remote metadata call failed at ${path}: ${(err as Error).message}`;
    const code = isTimeout ? 504 : 502;
    logRemoteMeta(log, 'error', reqId, {
      path,
      durationMs: Date.now() - startedAt,
      request_id: reqId,
      envelopeCode: code,
      error: message,
    });
    throw new KernelFetchError(code, message);
  } finally {
    clearTimeout(timer);
  }
}
