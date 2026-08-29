/**
 * mem:sync — 刷新当前 session 的全部注入缓存
 *
 * 底层动作覆盖：
 *   - 重新拉 Agent / Task detail 覆写到 SessionStore（描述、prompt、goal 都跟着更新）
 *   - 重跑所有声明了 session_init / hybrid 缓存策略的 hook（Skill / 记忆 /
 *     Knowledge / 固定资产 等），把新块 putMany 到 HookCacheRepo (COS)
 *
 * 文案侧只讲"资产 / 描述"这些用户能理解的概念，不暴露 injector id、hook 名字、
 * archive_key 等内部术语。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { refreshSessionCache, type RefreshResult } from "../../routes/session-refresh.js";

function buildSuccessMessage(result: RefreshResult): string {
  const parts: string[] = [];
  parts.push("Skill / 记忆 / Knowledge 资产");
  if (result.agentRefreshed || result.taskRefreshed) {
    parts.push("Task & Agent 描述");
  }
  const scope = parts.join("、");
  return `✅ 所有资产注入已刷新（${scope}），耗时 ${result.tookMs}ms`;
}

export async function executeSync(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  // 未绑定时不走 refreshSessionCache(它会暴露 session key 给用户)
  if (!ctx.sessionInfo || Object.keys(ctx.sessionInfo).length === 0) {
    const messageText = "⚠️ 当前会话未绑定团队资产，无法同步。请先用 `mem:session-reset` 选择 Team/Agent 后再试。";
    return {
      success: false,
      messageText,
      response: buildMemResponse(messageText, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
    };
  }

  const result = await refreshSessionCache({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    callerUserKey: ctx.apiKey,
  });

  const messageText = result.success
    ? buildSuccessMessage(result)
    : `❌ 资产刷新失败：${result.error ?? "未知错误"}`;

  const response = buildMemResponse(messageText, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });

  return {
    success: result.success,
    messageText,
    // 详细的 hookId 列表 / 时长 保留在结构化数据里给面板 / 日志用。
    data: result.success
      ? {
          refreshed: result.refreshed,
          skipped: result.skipped,
          agent_refreshed: result.agentRefreshed,
          task_refreshed: result.taskRefreshed,
          took_ms: result.tookMs,
        }
      : undefined,
    response,
  };
}
