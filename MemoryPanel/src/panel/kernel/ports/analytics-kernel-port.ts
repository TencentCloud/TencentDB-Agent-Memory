import type { MetaEnvelope } from '../envelope.js';
import type { MetaCallContext } from '../types.js';

/**
 * 内核 /v3/analytics/* 查询面透明代理端口。
 *
 * 与 MetaKernelPort 同形，但内部按 action 选择 GET / POST：
 * config、spaces 内核声明为 GET，其余为 POST。
 */
export interface AnalyticsKernelPort {
  invoke(
    action: string,
    body: Record<string, unknown>,
    ctx: MetaCallContext,
  ): Promise<MetaEnvelope>;
}
