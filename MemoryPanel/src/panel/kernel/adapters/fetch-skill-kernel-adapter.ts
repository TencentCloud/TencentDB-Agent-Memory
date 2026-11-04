import type { KernelHttpPort } from '../ports/kernel-http-port.js';
import type { SkillKernelPort } from '../ports/skill-kernel-port.js';
import { toKernelCredentials, type MetaCallContext } from '../types.js';

/**
 * 基于 fetch 的 skill 数据面适配器：POST /v3/skill/{action}。
 *
 * skill body 使用嵌套 pagination（不是顶层 limit/offset），故不做 meta 的
 * sanitizeBody 裁剪，原样透传。凭证与 meta 共用同一套（instance + api_key +
 * user_key），user_key 始终透传（skill 无 auth/verify 这类免鉴权动作）。
 */
export class FetchSkillKernelAdapter implements SkillKernelPort {
  constructor(
    private readonly http: KernelHttpPort,
    private readonly timeoutMs: number,
  ) {}

  invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext) {
    // A bounded GitHub snapshot download may outlast the normal metadata timeout.
    const timeoutMs = action.startsWith('github/') ? Math.max(this.timeoutMs, 75_000) : this.timeoutMs;
    const cred = toKernelCredentials(ctx, { timeoutMs });
    return this.http.postEnvelope(`/v3/skill/${action}`, body, cred);
  }
}
