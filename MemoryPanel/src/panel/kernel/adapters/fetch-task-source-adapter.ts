/**
 * Task 外部来源内核适配器。
 *
 * 为什么不是复用 FetchMetaKernelAdapter：
 *   它固定拼 `/v3/meta/${action}` 前缀，而 task-source 是独立的 `/v3/task-source/${action}`
 *   路由族（业务不在 meta 域内）。因此这里是一条独立但同构的转发路径：
 *   同样的信封协议、同样的实例头与 user_key 鉴权，只差路径前缀。
 *
 * 令牌注入：调用方通过 ctx.extraHeaders 传入，适配器不感知其语义，
 * 也不做任何持久化 —— 令牌只在这条内网链路上传递一次。
 */

import type { KernelHttpPort } from '../ports/kernel-http-port.js';
import { toKernelCredentials, type MetaCallContext } from '../types.js';
import type { MetaEnvelope } from '../envelope.js';
import type { TaskSourceKernelPort } from '../ports/task-source-kernel-port.js';

export class FetchTaskSourceAdapter implements TaskSourceKernelPort {
  constructor(
    private readonly http: KernelHttpPort,
    private readonly timeoutMs: number,
  ) {}

  invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext): Promise<MetaEnvelope> {
    const cred = toKernelCredentials(ctx, { timeoutMs: this.timeoutMs });
    return this.http.postEnvelope(`/v3/task-source/${action}`, body, cred);
  }
}
