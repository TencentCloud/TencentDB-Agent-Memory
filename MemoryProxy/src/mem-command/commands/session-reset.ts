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

export async function executeSessionReset(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const store = getSessionStore();
  const compositeKey = `${ctx.agentSource}:${ctx.sessionKey}`;

  // 记录 old 状态用于观测(埋点在 Commit 4 追加,现在只在返回值 data 里带上)
  const before = store.get(compositeKey);
  const oldStatus = before?.status ?? "uninitialized";
  const oldBypassed = !!before?.bypassed;

  const resetEpoch = Date.now();
  // 写 uninitialized 而非 pending_asset_confirm:
  //
  // pending_asset_confirm 意味着"proxy 已经弹了 form,等用户答复"—— 但 reset
  // 后的下一轮 body 里不会有 form tool_use/tool_result(因为 form 还没弹过)。
  // 如果写 pending_asset_confirm,下一轮 handleSessionInit 进入 "pending_asset_confirm
  // 分支" 试图从 user 消息解析 form 答案 → 解不出 → unrecognized → bypass →
  // 命令白跑了。
  //
  // 写 uninitialized 让下一轮走 Case 1 "第一次进来" 分支:重拉 teams → 弹
  // asset_confirm form。因为 Commit 2 已经删掉 isFreshCCConversation gate,
  // 即使 messages 很多也不会被 safety-net 拦截。
  const nextState: SessionInitState = {
    status: "uninitialized",
    keyId: ctx.sessionKey,
    startedAt: resetEpoch,
    attemptCount: 0,
    userId: ctx.userId,
    resetEpoch,
    resetFlow: true,
  };

  // 兜底 bind identity:handler 路径正常会先调 store.getOrRecover(compositeKey, identity, ...)
  // 完成 bind,但 pre-hook 前置拦截时 store 里未必已经 bind 过 —— 显式补一次
  // 保证 store.set 的 L2a write-through 能命中正确 namespace。
  store.bind(compositeKey, {
    userId: ctx.userId,
    agentSource: ctx.agentSource,
    sessionId: ctx.sessionKey,
    spaceId: ctx.spaceId,
  });

  await store.set(compositeKey, nextState);

  // 显式删除 L2b binding —— 否则下一次请求走 getOrRecover 时 step 3 rebuildFromBinding
  // 会用旧 initialized binding 直接灌回来,resetFlow 空跑。
  // store.set 内部已经 `deleteBinding` 了 pending 状态(只在 initialized 才 put),
  // 但为了防御性:这里显式 delete,不依赖 store.set 内部行为的实现细节。
  const bindingRepo = store.getBindingRepo();
  if (bindingRepo) {
    try {
      await bindingRepo.deleteBinding(ctx.spaceId, ctx.sessionKey);
    } catch (err) {
      console.warn(
        `[mem-command:session-reset] deleteBinding failed for ${compositeKey}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ── observability ────────────────────────────────────────────────────────
  // 结构化 audit log — 让运维在 dashboard / grep 时能精确抓到 session-reset
  // 事件。字段与后续 session_init_logs 的 completion 埋点对齐(same session_key /
  // agent_source),PM/运维可以 join 看"reset 触发 → 完成 init 的转化率"。
  // reset_epoch 用于跨节点一致性调试 —— pod A 写、pod B 读,若两侧看到不同的
  // reset_epoch 就能立刻定位 L2a probeL2a stale 的问题。
  console.log(
    `[session-reset] session=${compositeKey} space=${ctx.spaceId} user=${ctx.userId} ` +
      `agent_source=${ctx.agentSource} old_status=${oldStatus} old_bypassed=${oldBypassed} ` +
      `new_status=${nextState.status} reset_epoch=${resetEpoch}`,
  );

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
      reset_epoch: resetEpoch,
    },
    response,
  };
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
