/**
 * stages/session-reset-pre-hook.ts — mem:session-reset 前置拦截 stage。
 *
 * 提取自 4 处近乎相同的 pre-hook 块 (blueprint §2.4 复制粘贴, ~40 行 × 4):
 *   - openai-chat runner: header-only 拒绝分支 + 主 reset 流程
 *   - anthropic runner:   同 openai-chat
 *   - codex runner:       只有主 reset 流程 (codex 无 header-only 支持)
 *   - workbuddy runner:   同 codex
 *
 * 语义:
 *   1. header-only agent (pi/hermes/openclaw) 或 dsh headless: 收到 mem:session-reset
 *      → 返回"不支持"文案 (客户端不认 fake tool_call, 弹 form 会挂)
 *   2. 其他 agent: bind session → 归档旧 skill buffer (best-effort) → 重置 store
 *      → 删 binding, 让主 pipeline 后续弹 form 完成 reset
 *
 * caller 只需调用一次, 命中返 Response 直接返回, 未命中返 null 继续 pipeline。
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";

/** 支持的 protocol tag, 决定 mem 响应封装格式 */
export type SessionResetProtocol = "openai" | "anthropic" | "responses";

export interface SessionResetPreHookInput {
  c: Context;
  config: ProxyConfig;
  body: Record<string, unknown>;
  agentSource: string;
  sessionKey: string;
  spaceId: string;
  userId: string;
  isAuxiliary: boolean;
  dshHeadless: boolean;
  /** true = 允许 pre-hook 触发; anthropic 用 memoryTurn (requestKind=main && !legacyProxy),
   *  其他 protocol 用 !isAuxiliary && !dshHeadless。
   *  未提供时 stage 自己按 !isAuxiliary && !dshHeadless 计算。 */
  enabled?: boolean;
  isStream: boolean;
  protocol: SessionResetProtocol;
  /**
   * codex/wb 用: 从 body.input[] 里预抽出的 userText;
   * openai-chat / anthropic 传空字符串, stage 内走 parseMemCommand(body) 路径。
   */
  userText?: string;
  /** anthropic 传 body.thinking (buildMemResponse 需要) */
  thinking?: unknown;
  /**
   * workbuddy 老代码用 `codex:${sessionKey}` 作 compositeKey (agent-alias 兼容),
   * 其他 protocol 用 `${agentSource}:${sessionKey}`。默认后者, 传本参数覆盖。
   */
  compositeKeyOverride?: string;
}

/**
 * 返回 Response = 拦截并直接下发 (不 continue pipeline);
 * 返回 null = 未命中或已归档旧 buffer, caller 继续 pipeline (通常会弹 form)。
 */
export async function stageSessionResetPreHook(
  input: SessionResetPreHookInput,
): Promise<Response | null> {
  const { c, config, body, agentSource, sessionKey, spaceId, userId,
    isAuxiliary, dshHeadless, isStream, protocol, userText, thinking } = input;
  const gate = input.enabled ?? (!isAuxiliary && !dshHeadless);
  if (!gate) return null;

  // header-only agent + dsh headless: 走"不支持"分支 (openai-chat/anthropic only,
  // codex/wb 不会用 header-only 客户端故这一段无害地不触发)
  const { isHeaderOnlyAgent } = await import("../../session/preset.js");
  const noFormAgent = isHeaderOnlyAgent(agentSource) || dshHeadless;
  if (!isAuxiliary && noFormAgent) {
    const { isSessionResetCommand } = await import("../../mem-command/pre-intercept.js");
    if (isSessionResetCommand(body, agentSource)) {
      const { buildMemResponse } = await import("../../mem-command/response-builder.js");
      console.log(`[mem-command:pre] session-reset unsupported for agent=${agentSource} dshHeadless=${dshHeadless}`);
      const msg = isHeaderOnlyAgent(agentSource)
        ? `⚠️ mem:session-reset 不支持 ${agentSource} 客户端。\n\n`
          + `${agentSource} 通过 x-team-id / x-agent-id / x-task-id 请求头预选身份，没有交互式表单入口。\n`
          + `请在客户端配置中直接更改这些请求头来切换 Team / Agent / Task。`
        : "⚠️ mem:session-reset 不支持 dsh headless 模式。\n\n"
          + "dsh 客户端在 headless / no-preset 场景下不挂 ask_user_question tool，无法弹出资产选择表单。\n"
          + "请在带 ask_user_question preset 的 dsh 环境下使用。";
      return buildMemResponse(msg, {
        protocol,
        stream: isStream,
        requestId: `mem-reset-unsupported-${Date.now()}`,
        thinking: thinking as boolean | undefined,
      });
    }
  }

  // 主 reset 流程 (所有 4 protocol 共用)
  if (isAuxiliary || dshHeadless || isHeaderOnlyAgent(agentSource)) return null;

  const { isSessionResetCommand } = await import("../../mem-command/pre-intercept.js");
  if (!isSessionResetCommand(body, agentSource)) return null;

  // 识别命令 — codex/wb 用 parseCommandFromText(userText), 其他用 parseMemCommand(body)
  const { parseMemCommand, parseCommandFromText } = await import("../../mem-command/index.js");
  const memCmd = (protocol === "responses" && userText !== undefined)
    ? parseCommandFromText(userText)
    : parseMemCommand(body, agentSource);
  if (!memCmd) return null;

  const { getSessionStore } = await import("../../session/store.js");
  const store = getSessionStore();
  const compositeKey = input.compositeKeyOverride ?? `${agentSource}:${sessionKey}`;
  store.bind(compositeKey, { userId: userId || "anonymous", agentSource, sessionId: sessionKey, spaceId });

  // 强制归档旧 agent 的 skill buffer (best-effort)
  const oldState = store.get(compositeKey);
  if (oldState?.status === "initialized" && oldState.sessionInfo && config.coreSkill?.endpoint) {
    const si = oldState.sessionInfo as unknown as Record<string, string>;
    if (si.space_id && si.user_id && si.team_id && si.agent_id) {
      import("../../skill/core-client.js").then(({ getCoreSkillClient }) => {
        const client = getCoreSkillClient(config.coreSkill!);
        client.forceArchive(
          {
            space_id: si.space_id,
            user_id: si.user_id,
            team_id: si.team_id,
            agent_id: si.agent_id,
            session_id: sessionKey,
            task_id: si.task_id || undefined,
            reason: "session-reset",
          },
          { serviceId: si.space_id },
        ).then((res) => {
          console.log(`[session-reset] force-archive old buffer: status=${res.status} session=${sessionKey} agent=${si.agent_id}`);
        }).catch((err) => {
          console.warn(`[session-reset] force-archive failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
        });
      }).catch(() => { /* import fail */ });
    }
  }

  const resetEpoch = Date.now();
  await store.set(compositeKey, {
    status: "uninitialized",
    keyId: sessionKey,
    startedAt: resetEpoch,
    attemptCount: 0,
    userId: userId || "anonymous",
    resetEpoch,
    resetFlow: true,
  } as unknown as Parameters<typeof store.set>[1]);
  const bindingRepo = store.getBindingRepo();
  if (bindingRepo) await bindingRepo.deleteBinding(spaceId, sessionKey).catch(() => { /* best-effort */ });
  console.log(`[mem-command:pre] session-reset session=${sessionKey} → falling through to pop form`);

  // Note: void c 参数保留 (未来 stage 可能需要 header access), 当前不使用
  void c;

  return null; // 让 caller 继续 pipeline (走弹 form 逻辑)
}
