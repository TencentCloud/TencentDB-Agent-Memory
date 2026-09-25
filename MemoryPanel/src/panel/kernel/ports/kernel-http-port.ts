import type { MetaEnvelope } from '../envelope.js';
import type { KernelCredentials } from '../types.js';

export interface KernelHttpPort {
  /** POST 内核路径并返回完整信封（业务 code≠0 不抛错，供透明代理透传）。 */
  postEnvelope<T>(path: string, body: unknown, cred: KernelCredentials): Promise<MetaEnvelope<T>>;
  /** GET 内核路径并返回完整信封（/v3/analytics/config、spaces 等只读端点）。 */
  getEnvelope<T>(path: string, cred: KernelCredentials): Promise<MetaEnvelope<T>>;
}
