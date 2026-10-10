/**
 * stages/system-user.ts — systemUser 短路 stage (Phase 4 stage 化)。
 *
 * 提取自 4 处近乎相同的 systemUser 短路块:
 *   - openai-chat runner (line 665-670): body 传入
 *   - anthropic runner (line 691-696): body 传入
 *   - utility runner (line 117-120): 不传 body (auxHandler 自己再读)
 *
 * 语义 (blueprint §5.2):
 *   - hasSystemUsers()=false → 直接放过 null
 *   - matchSystemUserByUserId 匹配 → 立即 handleSystemUserPassthrough
 *   - 未匹配 → 返回 null 让 caller 继续 pipeline
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { matchSystemUserByUserId, hasSystemUsers } from "../../systemUser.js";
import { handleSystemUserPassthrough } from "../../systemUserPassthrough.js";

/**
 * 检查是否命中 systemUser 并立即 passthrough; 未命中返回 null。
 *
 * @param userId - 已 verify 过的 userId (从 stageAuth 拿), 空字符串 = 未鉴权跳过
 * @param body   - 可选: openai-chat/anthropic 已 parse 的 body 传入,
 *                 handleSystemUserPassthrough 会 serialize 送上游; utility 传 undefined。
 */
export async function stageSystemUser(
  c: Context,
  config: ProxyConfig,
  userId: string,
  body?: Record<string, unknown>,
): Promise<Response | null> {
  if (!hasSystemUsers()) return null;
  const sysMatch = matchSystemUserByUserId(userId);
  if (!sysMatch) return null;
  return handleSystemUserPassthrough(c, config, sysMatch, body);
}
