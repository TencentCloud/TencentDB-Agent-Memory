import { isAnalyticsGetAction } from '../../api/analytics-actions.js';
import type { KernelHttpPort } from '../ports/kernel-http-port.js';
import type { AnalyticsKernelPort } from '../ports/analytics-kernel-port.js';
import { toKernelCredentials, type MetaCallContext } from '../types.js';

/**
 * 基于 fetch 的 analytics 查询面适配器：/v3/analytics/{action}。
 *
 * method 按 action 分流：config / spaces 走 GET（内核只接受 GET，POST 会 405），
 * 其余走 POST 并原样透传 body（时间窗 days|from/to、space_id、分页 limit/offset
 * 等由内核 zod schema 校验，Panel 不做裁剪）。
 *
 * 凭证与 meta / skill 共用一套（instance + api_key + user_key）。user_key 始终
 * 透传：内核除 config 外都要求 system_admin，鉴权判定完全交给内核，Panel 不
 * 提前拦截（避免两侧权限模型漂移）。
 */
export class FetchAnalyticsKernelAdapter implements AnalyticsKernelPort {
  constructor(
    private readonly http: KernelHttpPort,
    private readonly timeoutMs: number,
  ) {}

  invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext) {
    const cred = toKernelCredentials(ctx, { timeoutMs: this.timeoutMs });
    const path = `/v3/analytics/${action}`;
    if (isAnalyticsGetAction(action)) {
      return this.http.getEnvelope(path, cred);
    }
    return this.http.postEnvelope(path, body, cred);
  }
}
