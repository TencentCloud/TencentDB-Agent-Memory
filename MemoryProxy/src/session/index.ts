/**
 * Session Initialization Module — Public API.
 *
 * 拆分后的架构：
 *   - codebuddy/    → CodeBuddy 专属 session-init（ask_followup_question form, XML extractor）
 *   - claude-code/  → Claude Code 专属 session-init（AskUserQuestion form, JSON extractor, 分页）
 *   - 共享模块：store.ts, types.ts, context-injector.ts, registrar.ts
 *
 * 内核 API 调用统一走 src/meta/client.ts (MetadataClient)。
 */

// ── 共享模块 ──────────────────────────────────────────────────────────────────

export { SessionStore, getSessionStore } from "./store.js";
export type {
  SessionInitStatus,
  SessionInitState,
  SessionInitData,
  SessionRegistrationData,
  SessionInfo,
  AgentDetail,
  TaskDetail,
  TeamOption,
  AgentInTeam,
  TaskInTeam,
  TaskOption as TaskOpt,
  AgentOption as AgentOpt,
} from "./types.js";

export { buildSessionInfo } from "./registrar.js";
export { injectSessionContext, SESSION_CONTEXT_OPEN, SESSION_CONTEXT_CLOSE } from "./context-injector.js";
export { parsePresetIdentity, resolvePresetIdentity } from "./preset.js";
export type { PresetIdentity, PresetResolution } from "./preset.js";

// ── CodeBuddy 专属模块 ─────────────────────────────────────────────────────────

export {
  handleSessionInit as handleCodeBuddySessionInit,
  buildFormResponse as buildCodeBuddyFormResponse,
  containsFormTitle as containsCodeBuddyFormTitle,
  extractFromOptionText as extractCodeBuddyFromOptionText,
  extractStructured as extractCodeBuddyStructured,
  resolveAgent as resolveCodeBuddyAgent,
  resolveTask as resolveCodeBuddyTask,
  BYPASS_MARKER as CB_BYPASS_MARKER,
  getLastUserMessageText as getCodeBuddyLastUserMessage,
} from "./codebuddy/index.js";

// ── Claude Code 专属模块 ───────────────────────────────────────────────────────

export {
  handleSessionInit as handleClaudeCodeSessionInit,
  buildFormResponse as buildClaudeCodeFormResponse,
  containsFormTitle as containsClaudeCodeFormTitle,
  extractFromOptionText as extractClaudeCodeFromOptionText,
  extractStructured as extractClaudeCodeStructured,
  resolveAgent as resolveClaudeCodeAgent,
  resolveTask as resolveClaudeCodeTask,
  BYPASS_MARKER as CC_BYPASS_MARKER,
  MORE_MARKER,
  getLastUserMessageText as getClaudeCodeLastUserMessage,
} from "./claude-code/index.js";

// ── 旧兼容 API（向后兼容 handler.ts 旧调用方式）─────────────────────────────────

import type { SessionInitConfig } from "../types.js";
import { SessionStore } from "./store.js";
import {
  handleSessionInit as cbHandle,
  SessionRequestContext as CBSessionRequestContext,
  SessionInitResult as CBSessionInitResult,
} from "./codebuddy/init.js";
import {
  handleSessionInit as ccHandle,
  SessionRequestContext as CCSessionRequestContext,
  SessionInitResult as CCSessionInitResult,
} from "./claude-code/init.js";
import {
  buildFormResponse as buildWorkBuddyFormResponse,
  FormData as WBFormData,
  FormStage as WBFormStage,
} from "./workbuddy/form.js";
import {
  buildFormResponse as buildDshFormResponse,
  FormData as DshFormData,
  FormStage as DshFormStage,
} from "./dsh/form.js";
import {
  buildFormResponse as buildOpencodeFormResponse,
  FormData as OCFormData,
  FormStage as OCFormStage,
} from "./opencode/form.js";

// Re-export the types under their old names for backward compat
export type SessionRequestContext = CBSessionRequestContext & Partial<CCSessionRequestContext>;
export type SessionInitResult = CBSessionInitResult;

/**
 * @deprecated 请使用 handleCodeBuddySessionInit() 或 handleClaudeCodeSessionInit()。
 * 此函数根据 agentSource 参数路由到对应的实现。
 */
import type { MetadataClient } from "../meta/client.js";
import type { PresetIdentity } from "./preset.js";

export async function handleSessionInit(
  sessionKey: string,
  userId: string | null,
  messages: Record<string, unknown>[],
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  agentSource: string = "codebuddy",
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
): Promise<SessionInitResult> {
  if (agentSource === "claude-code") {
    return ccHandle(
      sessionKey, userId, messages, config, store,
      // 直接透传整个 reqCtx，避免手抠字段时把新加字段（如 codex 的
      // codexAnswerInput）漏掉。protocol MUST be forwarded — without it,
      // applyArtifactsAndContext takes the openai path (injects
      // <session_context> into messages as a role=system message) instead of
      // the anthropic path (returns systemAppend that anthropicHandler merges
      // into body.system). The openai path currently only works because
      // AnthropicAdapter.serialize() hoists role=system back onto body.system
      // as a safety net; forwarding the correct protocol keeps intent and
      // implementation aligned and survives `injection.enabled=false`.
      reqCtx,
      metadataClient,
      userKey,
      spaceId,
      presetIdentity,
    );
  }
  // 同上：整个 reqCtx 透传给 CB 状态机。codexHandler 会把 body.input[] 塞在
  // reqCtx.codexAnswerInput 里，供 CB 状态机内部的 codex-only pre-checks 段
  // （session/codebuddy/init.ts 里 detectCodexDefaultGate + detectCodexMore）
  // 识别 Default gate 与 MORE 翻页。手抠字段会把它丢掉 → codex 分页失效。
  const result = await cbHandle(
    sessionKey, userId, messages, config, store,
    reqCtx,
    metadataClient,
    userKey,
    spaceId,
    presetIdentity,
    agentSource,
  );

  // WorkBuddy 客户端复用 CB 状态机（uninitialized → pending_team → pending_agent_task
  // → initialized 全套流程），但 form 渲染需要用 CC 的 `AskUserQuestion` shape +
  // OpenAI chat/completions SSE tool_calls 传输（WB 客户端是 CC tool 语义 +
  // OpenAI 协议的混合体，抓包 [wb-ask-user-schema] 已实证）。
  //
  // 参照 codex 的模式（`session/codex/form.ts::buildFormResponse`），这里在 CB
  // 状态机产出 formData 后**外层重渲染**：丢掉 result.response（CB 的
  // ask_followup_question SSE），改用 workbuddy/form.ts 生成 AskUserQuestion SSE。
  // 好处：CB 状态机代码零改动，10 处 intercepted 站点无需逐个分派。
  if (agentSource === "workbuddy" && result.intercepted && result.formData) {
    const cbFd = result.formData;
    const wbFd: WBFormData = {
      teams: cbFd.teams,
      // CB 状态机的 stage 值 (asset_confirm | team | agent_select | task_select |
      // agent_task) 与 WB form 的 FormStage 完全一致；直接透传。
      stage: cbFd.stage as WBFormStage,
      selectedTeamId: cbFd.selectedTeamId,
      selectedAgentId: cbFd.selectedAgentId,
      // CB 携带的翻页字段有 teamPage / agentPage / taskPage（codex 透传用），
      // WB form 用单个 pageIndex —— 根据当前 stage 挑对应页码。
      pageIndex:
        cbFd.stage === "team" ? cbFd.teamPage
        : cbFd.stage === "agent_select" ? cbFd.agentPage
        : cbFd.stage === "task_select" ? cbFd.taskPage
        : 0,
      retry: cbFd.retry,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
    };
    result.response = buildWorkBuddyFormResponse(wbFd);
  }

  // dsh (deepseek-harness) 客户端复用 CB 状态机 + 自己的 ask_user_question 载体。
  // 与 workbuddy 完全对称：CB 状态机产出 formData 后外层重渲染 response,不共用
  // CB 的 ask_followup_question(dsh preset 挂的是 dsh 原生 ask_user_question,
  // 抓包实证 fixtures/dsh-tool-catalog-schema.json)。stage 值完全一致直接透传;
  // dsh form 用 CC-shape 的单一 pageIndex,同 workbuddy 挑分页字段。
  if (agentSource === "dsh" && result.intercepted && result.formData) {
    const cbFd = result.formData;
    const dshFd: DshFormData = {
      teams: cbFd.teams,
      stage: cbFd.stage as DshFormStage,
      selectedTeamId: cbFd.selectedTeamId,
      selectedAgentId: cbFd.selectedAgentId,
      pageIndex:
        cbFd.stage === "team" ? cbFd.teamPage
        : cbFd.stage === "agent_select" ? cbFd.agentPage
        : cbFd.stage === "task_select" ? cbFd.taskPage
        : 0,
      retry: cbFd.retry,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
    };
    result.response = buildDshFormResponse(dshFd);
  }

  // opencode 客户端（sst/opencode CLI，Bun 打包二进制）在 agent-loop 里维护一个
  // 硬白名单 tools 集合：`bash, edit, glob, grep, invalid, question, read,
  // skill, task, todowrite, webfetch, write`。任何名字不在白名单里的 tool_call
  // 都会被客户端拒收并渲染成 `invalid [tool=xxx, error=Model tried to call
  // unavailable tool]`（抓包 2026-08-19 实证：CB 的 `ask_followup_question`
  // 被拒 3 次后 CB 状态机 abandon → 走 bypass）。
  //
  // 解决：与 workbuddy / dsh 完全对称——CB 状态机产出 formData 后**外层重渲染**，
  // 换成 opencode 原生 `question` 工具的 tool_call SSE。stage 值直接透传，
  // 分页字段按当前 stage 挑对应页码。
  //
  // 详见：session/opencode/form.ts 头部注释（schema 依据 / 三处 shape 差异）。
  if (agentSource === "opencode" && result.intercepted && result.formData) {
    const cbFd = result.formData;
    const ocFd: OCFormData = {
      teams: cbFd.teams,
      stage: cbFd.stage as OCFormStage,
      selectedTeamId: cbFd.selectedTeamId,
      selectedAgentId: cbFd.selectedAgentId,
      pageIndex:
        cbFd.stage === "team" ? cbFd.teamPage
        : cbFd.stage === "agent_select" ? cbFd.agentPage
        : cbFd.stage === "task_select" ? cbFd.taskPage
        : 0,
      retry: cbFd.retry,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
    };
    result.response = buildOpencodeFormResponse(ocFd);
  }

  return result;
}
