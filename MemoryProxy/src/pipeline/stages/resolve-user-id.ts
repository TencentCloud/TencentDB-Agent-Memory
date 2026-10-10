/**
 * stages/resolve-user-id.ts — userId 4 层 fallback + debugForceUserId 覆盖。
 *
 * 提取自 openai-chat + anthropic runner ~15 行 相同的 userId resolve 块。
 * 语义:
 *   1. 优先 earlyVerify.userId (auth service 已解出)
 *   2. 回退 header: x-user-id / x-cb-user-id / x-tdai-user-token
 *   3. debugForceUserId 强制覆盖 (本地联调)
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";

export interface ResolveUserIdInput {
  c: Context;
  config: ProxyConfig;
  earlyVerifyUserId: string;
  logTag: string;
}

export function stageResolveUserId(input: ResolveUserIdInput): string {
  const { c, config, earlyVerifyUserId, logTag } = input;
  let userId = earlyVerifyUserId
    || c.req.header("x-user-id")
    || c.req.header("x-cb-user-id")
    || c.req.header("x-tdai-user-token")
    || "";
  const debugForceUserId = config.sessionInit?.debugForceUserId;
  if (debugForceUserId) {
    console.log(
      `[${logTag}] DEBUG override userId ${userId || "<empty>"} → ${debugForceUserId}`,
    );
    userId = debugForceUserId;
  }
  return userId;
}
