/**
 * stages/session-bypass.ts — session-init "bypass 分支" 后置处理小 helper。
 *
 * 抽自 4 runner 里 ~6 行同构 (但 caller-owned 变量名不同, 无法就地 mutate):
 *   if (initResult.bypassed) {
 *     injection[Ss]kipped = true;
 *     console.log("... bypassed → skipping injection");
 *     if (initResult.resetFlow) _resetFlowResult = { ...teamId(Short)?, bypassed: true };
 *   }
 *
 * 返回结构化 result 供 caller 应用, 不直接 mutate caller 变量。
 *
 * 目的:
 *   1. 让 "bypassed → skipInjection + 空 resetFlow" 约束显式化 (blueprint §5.2 red-line)
 *   2. 消灭 4 处小 duplicate, 未来加 agent 只加 caller side apply
 *
 * 差异保留 (caller 显式处理):
 *   - wb 用 teamIdShort, 其他 3 家用 teamId — 通过 useTeamIdShort 参数
 *   - wb 独有 bypassReason 打入 log — 通过 extraLog 参数
 *   - warn 前缀 4 家各自
 */

export interface SessionBypassInput {
  bypassed: boolean;
  resetFlow: boolean;
  sessionKey: string;
  /** log 前缀 (如 "[codex]" / "[workbuddy]" / "[session-init]") */
  logPrefix: string;
  /** wb 独有: log 里追加的 " (reason=xxx)" 段 (其他 3 家传空字符串) */
  extraLog?: string;
  /** wb 独有: bypass reset 时 resetFlowResult 字段用 teamIdShort 而非 teamId */
  useTeamIdShort?: boolean;
}

export interface ResetFlowBypassResult {
  agentName: string;
  agentIdShort: string;
  teamId?: string;
  teamIdShort?: string;
  bypassed: boolean;
}

export interface SessionBypassResult {
  /** 是否 bypass 生效 (caller 用来 set 自己那个变量: injectedSkipped 或 injectionSkipped) */
  skipInjection: boolean;
  /** bypass reset-flow 时的 _resetFlowResult 内容 (为 undefined 时 caller 不动) */
  resetFlowResult?: ResetFlowBypassResult;
}

export function stageSessionBypass(input: SessionBypassInput): SessionBypassResult {
  if (!input.bypassed) {
    return { skipInjection: false };
  }

  console.log(
    `${input.logPrefix} session=${input.sessionKey}${input.extraLog ?? ""} bypassed → skipping injection`,
  );

  if (input.resetFlow) {
    const resetFlowResult: ResetFlowBypassResult = input.useTeamIdShort
      ? { agentName: "", agentIdShort: "", teamIdShort: "", bypassed: true }
      : { agentName: "", agentIdShort: "", teamId: "", bypassed: true };
    return { skipInjection: true, resetFlowResult };
  }

  return { skipInjection: true };
}
