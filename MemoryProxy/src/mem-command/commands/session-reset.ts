/**
 * mem:session-reset — 重置当前 session 的绑定, 在会话中间重新走 session-init 表单.
 *
 * 语义:不管当前 state 是 uninitialized / pending_* / initialized / bypassed,
 * 命令执行后一律进入 `pending_asset_confirm`,并携带 `resetEpoch = Date.now()` +
 * `resetFlow = true`。下一次请求进来时,`handleSessionInit` 会因 state !==
 * initialized 而弹 asset_confirm 表单,用户重新选择 Team/Agent/Task。
 *
 * 跨节点一致性:
 *   - 写入 store 走 `store.set` write-through,L1 + L2a(SessionRepo) 同步落盘
 *   - 别的 pod 的 L1 里可能还有旧 initialized —— `store.getOrRecover` step 1
 *     用 resetEpoch 对齐 L2a,发现 L2a.resetEpoch 更大就打破 L1 短路,拿新
 *     pending 状态弹表单
 *   - L2b binding (initialized 时的"小纸条") 显式删除,避免下一轮 `rebuildFromBinding`
 *     把旧 initialized 直接灌回来
 *
 * 文案:参照 create-skill 的口味,只暴露"重置/关联/团队资产"等用户能理解的
 * 词,不出现 status / resetEpoch / binding / pending_asset_confirm 等内部术语。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getSessionStore } from "../../session/store.js";
import type { SessionInitState } from "../../session/types.js";
import type { ProxyConfig } from "../../types.js";
import { getCoreSkillClient } from "../../skill/core-client.js";
import { invalidateInitLinkTokensForSession } from "../../session/init-link.js";

export interface ResetSessionBindingInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  userId: string;
}

export interface ResetSessionBindingResult {
  oldStatus: string;
  oldBypassed: boolean;
  nextState: SessionInitState;
}

export async function executeSessionReset(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const { oldStatus, oldBypassed, nextState } = await resetSessionBinding({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    userId: ctx.userId,
  });

  const messageText = buildSuccessMessage(oldStatus, oldBypassed);

  const response = buildMemResponse(messageText, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });

  return {
    success: true,
    messageText,
    // 结构化数据只在日志/面板可见,不进用户可读文案
    data: {
      old_status: oldStatus,
      old_bypassed: oldBypassed,
      new_status: nextState.status,
      reset_epoch: nextState.resetEpoch,
    },
    response,
  };
}

export async function resetSessionBinding(
  input: ResetSessionBindingInput,
): Promise<ResetSessionBindingResult> {
  const store = getSessionStore();
  const compositeKey = `${input.agentSource}:${input.sessionKey}`;
  const before = store.get(compositeKey);
  const oldStatus = before?.status ?? "uninitialized";
  const oldBypassed = !!before?.bypassed;

  if (
    before?.status === "initialized" &&
    before.sessionInfo &&
    input.config.coreSkill?.endpoint
  ) {
    const sessionInfo = before.sessionInfo;
    if (
      sessionInfo.space_id &&
      sessionInfo.user_id &&
      sessionInfo.team_id &&
      sessionInfo.agent_id
    ) {
      try {
        const client = getCoreSkillClient(input.config.coreSkill);
        const result = await client.forceArchive(
          {
            space_id: sessionInfo.space_id,
            user_id: sessionInfo.user_id,
            team_id: sessionInfo.team_id,
            agent_id: sessionInfo.agent_id,
            session_id: input.sessionKey,
            task_id: sessionInfo.task_id,
            reason: "session-reset",
          },
          { serviceId: sessionInfo.space_id },
        );
        console.log(
          `[session-reset] force-archive old buffer: status=${result.status} ` +
            `session=${input.sessionKey} agent=${sessionInfo.agent_id}`,
        );
      } catch (err) {
        console.warn(
          `[session-reset] force-archive failed (best-effort): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  const resetEpoch = Date.now();
  const nextState: SessionInitState = {
    status: "uninitialized",
    keyId: input.sessionKey,
    startedAt: resetEpoch,
    attemptCount: 0,
    userId: input.userId,
    resetEpoch,
    resetFlow: true,
  };
  store.bind(compositeKey, {
    userId: input.userId,
    agentSource: input.agentSource,
    sessionId: input.sessionKey,
    spaceId: input.spaceId,
  });
  await store.set(compositeKey, nextState);

  const bindingRepo = store.getBindingRepo();
  if (bindingRepo) {
    try {
      await bindingRepo.deleteBinding(input.spaceId, input.sessionKey);
    } catch (err) {
      console.warn(
        `[mem-command:session-reset] deleteBinding failed for ${compositeKey}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  invalidateInitLinkTokensForSession(compositeKey);

  console.log(
    `[session-reset] session=${compositeKey} space=${input.spaceId} user=${input.userId} ` +
      `agent_source=${input.agentSource} old_status=${oldStatus} old_bypassed=${oldBypassed} ` +
      `new_status=${nextState.status} reset_epoch=${resetEpoch}`,
  );
  return { oldStatus, oldBypassed, nextState };
}

/**
 * 根据老状态构造用户可读文案。
 *
 * 老状态       文案强调
 * uninitialized 「继续对话时会弹出选择」
 * initialized   「已解除绑定,请重新选择」
 * bypassed      「已恢复选择入口」
 * pending_*     「已重新开始选择」
 */
function buildSuccessMessage(oldStatus: string, oldBypassed: boolean): string {
  if (oldStatus === "uninitialized") {
    return "✅ 已重置,继续对话时会弹出团队资产选择";
  }
  if (oldBypassed) {
    return "✅ 已恢复团队资产选择入口,继续对话时会弹出重新选择";
  }
  if (oldStatus === "initialized") {
    return "✅ 已解除本次会话的团队资产绑定,继续对话时会弹出重新选择";
  }
  // pending_*
  return "✅ 已重新开始团队资产选择,继续对话时会弹出选择";
}
