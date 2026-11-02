import type { MetaEnvelope } from './envelope.js';

export interface KernelCredentials {
  endpoint: string;
  apiKey: string;
  instanceId: string;
  userKey?: string;
  timeoutMs: number;
  requestId?: string;
  /** 额外请求头（task-source 令牌注入等）。不进日志。 */
  extraHeaders?: Record<string, string>;
}

/** 单次内核元数据调用的运行时凭证（middleware 从 Header + 注册表组装）。 */
export interface MetaCallContext {
  instanceId: string;
  gatewayEndpoint: string;
  gatewayApiKey: string;
  userKey?: string;
  reqId?: string;
  /** 额外请求头（task-source 令牌注入等）。不进日志。 */
  extraHeaders?: Record<string, string>;
}

export type { MetaEnvelope };

export function toKernelCredentials(
  ctx: MetaCallContext,
  config: { timeoutMs: number },
  opts?: { omitUserKey?: boolean },
): KernelCredentials {
  const omitUserKey = opts?.omitUserKey;
  const userKey = omitUserKey ? undefined : ctx.userKey;
  return {
    endpoint: ctx.gatewayEndpoint,
    apiKey: ctx.gatewayApiKey,
    instanceId: ctx.instanceId,
    userKey,
    timeoutMs: config.timeoutMs,
    requestId: ctx.reqId,
    extraHeaders: ctx.extraHeaders,
  };
}
