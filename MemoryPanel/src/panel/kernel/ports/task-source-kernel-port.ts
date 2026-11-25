import type { MetaCallContext } from '../types.js';
import type { MetaEnvelope } from '../envelope.js';

/** Core /v3/task-source/* 的调用面（Panel 侧薄转发）。 */
export interface TaskSourceKernelPort {
  invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext): Promise<MetaEnvelope>;
}
