/**
 * CodeBuddy Session Initialization — 状态机入口.
 *
 * Flow:
 *   1. uninitialized → 内核拉 teams[], 发 `ask_followup_question` form
 *   2. pending_team_select → 解析用户 team 选择, 发 agent_task form
 *   3. pending_agent_task → 解析 agent+task, fetch 详情, register, inject
 *   4. initialized → 每次请求 strip + inject
 */

import type { SessionInitConfig } from "../../types.js";
import type {
  AgentDetail,
  SessionInitData,
  SessionInitState,
  SessionRegistrationData,
  TaskDetail,
  TaskInTeam,
  TeamOption,
} from "../types.js";
import { DEFAULT_TASK_LABEL } from "../types.js";
import { SessionStore } from "../store.js";
import { buildSessionInfo } from "../registrar.js";
import { injectSessionContextWithToggles } from "../context-injector.js";
import type { MetadataClient } from "../../meta/client.js";
import { resolvePresetIdentity, type PresetIdentity } from "../preset.js";

import { buildFormResponse, FormData } from "./form.js";
import {
  extractFromOptionText,
  extractTeamFromOptionText,
  extractAssetConfirm,
  extractStructured,
  extractAgentOnly,
  extractTaskOnly,
  resolveAgent,
  resolveTask,
  BYPASS_MARKER,
} from "./extractor.js";
import { getLastUserMessageText } from "./cleaner.js";
import { emitSessionInitTelemetryIfCompleted } from "../init-telemetry.js";
import { isDshRuntimeContextSnapshot } from "../../common/user-query-extractor.js";
import {
  CODEX_MORE_LABEL,
  DEFAULT_GATE_PREFIX,
  detectCodexMore,
} from "../codex/form.js";
// WorkBuddy 复用 CC 的 AskUserQuestion form + CC 分页布局（workbuddy/form.ts 直接
// import computePagination + MORE_LABEL="更多 →"）。WorkBuddy 走 CB 状态机时的
// MORE 翻页拦截需要用同一套 MORE_LABEL 判定 + computePagination 判越界，才能与
// form 侧切片对齐。CC 的 MORE_LABEL 值与 workbuddy/form.ts 完全一致。
import { MORE_LABEL as WB_MORE_LABEL } from "../claude-code/form.js";
import { computePagination as computeCCPagination } from "../claude-code/pagination.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SessionRequestContext {
  stream: boolean;
  modelId: string;
  protocol?: "openai" | "anthropic";
  /**
   * codex 客户端专属：codex 的答复不走 CB 兼容的 messages[]，而是塞在
   * `body.input[]` 里的 `function_call_output` 项。codexHandler 已经用
   * `codexFormAnswersAsMessages` 转出一份 `messages` 交给 CB 状态机做正常的
   * 选项匹配，但状态机内部还需要**原始** input[] 才能：
   *   1. 检测 Default 模式 gate 字符串（客户端每次会回放历史 gate output）
   *   2. 按 question id 精确定位 MORE 命中的是 team/agent/task 哪个
   *
   * CC/普通 CB 场景永远不传此字段。
   */
  codexAnswerInput?: unknown[];
  /**
   * CB v1.106+ 的 ask_followup_question schema 要求 questions 为真 array；
   * 老版本期望 JSON 字符串。handler 从 body.tools 中检测后填入此字段，
   * form builder 据此决定是否 JSON.stringify(questions)。
   * 未设置时默认 true（向新版对齐）。
   */
  questionsAsArray?: boolean;
}

export interface SessionInitResult {
  intercepted: boolean;
  response?: Response;
  messages?: Record<string, unknown>[];
  sessionInfo?: import("../types.js").SessionInfo | null;
  justRegistered?: boolean;
  agentDetail?: AgentDetail | null;
  taskDetail?: TaskDetail | null;
  /** 用户选"否"不关联团队资产 → bypass 路径，所有注入钩子应跳过。 */
  bypassed?: boolean;
  /**
   * bypass 触发原因（仅 `bypassed === true` 时有意义）。codexHandler 用它决定
   * 首次 gate 命中是否要返 "Plan 模式提示" 而非直接透传。
   *
   * - "default-gate"  → codex 客户端 Default 模式截断了我们的 request_user_input
   *                     并伪造出 "request_user_input is unavailable in Default mode"
   *                     字符串；codexHandler 应返一次 Plan 模式提示后再进入 bypass
   *                     稳态。
   * - undefined       → 其它 bypass 路径（用户显式选"否"、no-agents、preset
   *                     mismatch 等），走各自 handler 的默认 bypass 行为。
   *
   * CC/CB 客户端本身触发不到 default-gate（客户端不会伪造 gate 字符串），保留
   * 常量供跨 handler 判定即可。
   */
  bypassReason?: "default-gate";
  /**
   * Anthropic-only: pre-built `<session_context>` string the caller must
   * append to `body.system` (the ClaudeCode init module populates this;
   * CodeBuddy stays OpenAI so it is always undefined here). Kept in this
   * interface so `session/index.ts`'s union type stays uniform.
   */
  systemAppend?: string | null;
  /**
   * 原始 FormData —— 当 `intercepted === true` 时**总是**填充。
   *
   * codex handler 拿到后用 `session/codex/form.ts::buildFormResponse` 重渲染成
   * OpenAI Responses API SSE 格式（`response.output_item.added` +
   * `function_call` item）。CB / CC 自身不会读这个字段——`response` 已经是它们
   * 各自协议下的完整响应。
   */
  formData?: FormData;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type MessageArr = Record<string, unknown>[];

/**
 * codex-only: 判定 `body.input[]` 里最后一个 function_call_output 是否为
 * 客户端 Default 模式 gate 拦截。客户端每轮会带上历史 gate output，因此
 * "是否首次命中"由调用方看 sessionStore.bypassed 判断，这里只负责结构识别。
 *
 * CB/CC 客户端从不会发这个字符串，所以放在 CB 状态机里 opt-in 检测 codex 专属
 * 场景（agentSource==="codex" + reqCtx.codexAnswerInput 非空）依然安全。
 */
function detectCodexDefaultGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  // 只识别"input 的最后一个 item 就是 gate output"的情况 —— 即这一轮 codex 客户端
  // 拦截了 tool_call 并直接 replay gate。
  //
  // 为什么必须看**最末 item** 而不是"最新的 function_call_output"：
  // codex 客户端每一轮都 replay 整个历史 input,一旦历史里出现过 Default 模式的
  // gate output,它会永远沉淀在 input 里。用户从 Default 切到 Plan 后重发命令,
  // 客户端会在 input 尾部**追加一条新的 user message**（那条 mem:session-reset
  // 或用户对 form 的答复）,老 gate output 仍留在中间。若扫"最新 function_call_output"
  // 则永远命中老 gate,死循环卡住"请切到 Plan 模式"文案。
  //
  // 只有当尾部就是 function_call_output(说明客户端刚 replay gate,还没让用户输入)
  // 才判 Default;若尾部是 user message / tool_use / 其他 → 说明当前是新一轮 turn,
  // 忽略历史残留 gate。
  const last = input[input.length - 1] as Record<string, unknown> | null | undefined;
  if (!last || typeof last !== "object") return false;
  if (last.type !== "function_call_output") return false;
  const output = last.output;
  return typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX);
}

/**
 * codex-only: 根据 recovered.status + detectCodexMore().perQuestion 决定
 * 应该 bump 的 pageIndex（team/agent/task）。返回 bump 结果与已经填好的
 * 新 codexPageIndex object；调用方拿去写 state + 重发同 stage 的 form。
 *
 * partialMore 场景（agent 是真选、task=更多）：直接把 task 那侧 pageIndex+1
 * 后交给 CB 状态机继续消费——CB 只会命中真选 agent 推进大状态；task 那侧靠
 * 下一 stage form 的 taskPage 值重新出题。
 */
function computeCodexPageBumps(
  cur: { teamPage?: number; agentPage?: number; taskPage?: number } | undefined,
  perQuestion: { team_select: boolean; agent_select: boolean; task_select: boolean },
  fallbackStage: "team" | "agent" | "task" | null,
): { next: { teamPage: number; agentPage: number; taskPage: number }; bumped: Array<"team" | "agent" | "task"> } {
  const teamPage = cur?.teamPage ?? 0;
  const agentPage = cur?.agentPage ?? 0;
  const taskPage = cur?.taskPage ?? 0;
  const bumped: Array<"team" | "agent" | "task"> = [];
  let nextTeam = teamPage;
  let nextAgent = agentPage;
  let nextTask = taskPage;
  if (perQuestion.team_select) { nextTeam++; bumped.push("team"); }
  if (perQuestion.agent_select) { nextAgent++; bumped.push("agent"); }
  if (perQuestion.task_select) { nextTask++; bumped.push("task"); }
  if (bumped.length === 0 && fallbackStage) {
    if (fallbackStage === "team") { nextTeam++; bumped.push("team"); }
    else if (fallbackStage === "agent") { nextAgent++; bumped.push("agent"); }
    else if (fallbackStage === "task") { nextTask++; bumped.push("task"); }
  }
  return { next: { teamPage: nextTeam, agentPage: nextAgent, taskPage: nextTask }, bumped };
}

/**
 * 生成带上 codex 分页页码的 FormData，供 codex handler 重渲染。CB 客户端
 * 会忽略这些页码字段（CB `ask_followup_question` 不分页）。
 */
function withCodexPageIndex(
  fd: FormData,
  px: { teamPage?: number; agentPage?: number; taskPage?: number } | undefined,
): FormData {
  if (!px) return fd;
  return {
    ...fd,
    teamPage: px.teamPage ?? 0,
    agentPage: px.agentPage ?? 0,
    taskPage: px.taskPage ?? 0,
  };
}

/**
 * WorkBuddy-only: 检测某一 stage 的用户答复是否点了 "更多 →"，命中则算出翻页后
 * 的 pageIndex（越界回绕到第 0 页）。
 *
 * 背景：WorkBuddy（agentSource="workbuddy"）复用 CB 状态机跑
 * uninitialized → pending_team_select → pending_agent_select → pending_task_select
 * 全套流程，但 form 渲染走 workbuddy/form.ts（AskUserQuestion + CC 分页，
 * MORE_LABEL="更多 →"）。CB 状态机原本只在 agentSource="codex" 分支拦截 MORE
 * （B 段的 isCodexSource 门控），WorkBuddy 落到 pending_*_select 分支后
 * extractAgentOnly/extractTaskOnly 不识别 "更多 →" → 未识别 → 无限重发第 1 页。
 *
 * 修法：在每个 pending_*_select 分支入口、跑 extractor 之前，先用本函数判定
 * MORE。命中就 bump 对应 stage 的页码并重发同 stage form（页码经
 * session/index.ts 的 workbuddy 重渲染分支按 stage 从 codexPageIndex 挑出，
 * 传给 workbuddy/form.ts 的 pageIndex）。
 *
 * @param answerText  getLastUserMessageText(messages) 提取的用户答复文本
 * @param currentPage 当前 stage 的页码（0-based）
 * @param total       当前 stage 候选总数（agents.length / tasks.length / teams.length）
 * @returns null=非 MORE；number=翻页后的 pageIndex（越界回绕 0）
 */
function detectWorkbuddyMorePage(
  answerText: string,
  currentPage: number,
  total: number,
): number | null {
  if (!answerText.includes(WB_MORE_LABEL)) return null;
  const nextPage = currentPage + 1;
  // 用与 form 侧同款分页算法判越界，防止翻过末页后停在越界页导致 form 抛
  // solo-page 断言；对齐 claude-code/init.ts 的 safeNextPage 回绕逻辑。
  const totalPages = computeCCPagination(Math.max(0, total), 0).totalPages;
  return nextPage > totalPages - 1 ? 0 : nextPage;
}

/** 判断是否是「全新」CodeBuddy / dsh 对话（最多一条真用户输入、无 assistant/tool）。
 *
 * dsh (deepseek-harness) 首帧 body 里塞 3 条**非用户输入**的 role=user 元数据:
 *   - <system-reminder> 工作区指令
 *   - "Current runtime context." 快照
 *   - <system-reminder>\nA skill is a reusable... 的 <available_skills> 列表
 * 若原样计数会把 dsh 首帧误判为"非全新"→ 上层 safety-net 跳过 session-init。
 * 这里在计数时跳过带 dsh 元数据签名的 user 消息(str content 且以已知锚点开头)。
 * 见 MemoryProxy/docs/dsh-recon/2026-08-14-dsh-capture-analysis.md §2.3。
 */
function isFreshCBConversation(messages: MessageArr): boolean {
  let userCount = 0;
  for (const m of messages) {
    const role = (m.role as string) ?? "";
    if (role === "assistant" || role === "tool") return false;
    if (role !== "user") continue;
    // dsh 元数据 user 消息不算真用户输入
    const c = (m as { content?: unknown }).content;
    if (typeof c === "string") {
      if (
        c.startsWith("<system-reminder>") ||
        isDshRuntimeContextSnapshot(c)
      ) {
        continue;
      }
    }
    userCount++;
    if (userCount > 1) return false;
  }
  return userCount <= 1;
}

async function fetchTeamsAndAgents(
  userId: string,
  config: SessionInitConfig,
  metadataClient: MetadataClient,
): Promise<{ teams: TeamOption[] }> {
  const teamsRaw = await metadataClient.listTeams(userId);
  const teams: TeamOption[] = [];

  // Parallel fan-out: for each team, fetch agents & tasks concurrently
  const teamResults = await Promise.all(
    teamsRaw.map(async (t) => {
      const [agentsRaw, tasksRaw] = await Promise.all([
        // Agents are scoped to (team, owner) — each user only sees the agents
        // they created within the team. Tasks remain team-wide (unchanged).
        metadataClient.listAgents(t.team_id, userId),
        metadataClient.listTasks(t.team_id),
      ]);
      const tasks: TaskInTeam[] = tasksRaw.map((tk) => ({
        task_id: tk.task_id,
        task_name: tk.title,
      }));
      // 见 claude-code/init.ts fetchTeamsAndAgents 的同款注释：defaultTaskId
      // 在源头 unshift 到 tasks 列表头部，下游 form/extractor 走既有路径。
      if (config.defaultTaskId) {
        tasks.unshift({
          task_id: config.defaultTaskId,
          task_name: DEFAULT_TASK_LABEL,
          isDefault: true,
        });
      }
      return {
        team_id: t.team_id,
        team_name: t.name,
        agents: agentsRaw.map((a) => ({
          agent_id: a.agent_id,
          agent_name: a.name,
          description: a.description ?? undefined,
        })),
        tasks,
      };
    }),
  );
  teams.push(...teamResults);
  return { teams };
}

function findTeamIdForAgent(teams: TeamOption[], agentId: string): string | undefined {
  for (const team of teams) {
    if (team.agents.some((a) => a.agent_id === agentId)) return team.team_id;
  }
  return undefined;
}

/**
 * Assemble the registration payload for a resolved (agent, task). Returns
 * `null` when the agent cannot be matched to any team in the cached list —
 * the caller must bypass session init in that case (there is no
 * `defaultTeamId` fallback any more).
 */
function buildRegistrationData(
  extracted: SessionInitData,
  cachedTeams: TeamOption[],
  sessionId: string,
  userId: string,
): SessionRegistrationData | null {
  const teamId = findTeamIdForAgent(cachedTeams, extracted.agent_id);
  if (!teamId) return null;
  return {
    team_id: teamId,
    user_id: userId,
    agent_id: extracted.agent_id,
    task_id: extracted.task_id,
    session_id: sessionId,
  };
}

function applyArtifactsAndContext(
  messages: MessageArr,
  agentDetail: AgentDetail | null | undefined,
  taskDetail: TaskDetail | null | undefined,
  sessionKey: string,
  config: SessionInitConfig,
): MessageArr {
  // 曾经这里会按 config.keepInitArtifacts 决定要不要 stripInitArtifacts,
  // 现在**永远保留** session_init form 交互, 不做任何删除。
  const injected = injectSessionContextWithToggles(messages, agentDetail, taskDetail, config, sessionKey);
  if (injected !== messages) {
    const finalRoles = (injected as unknown[]).map((m: any) => m.role);
    console.log(
      `[session-init:cb] session=${sessionKey} processed: ${messages.length} msgs, ` +
        `ctx=${agentDetail ? "Y" : "N"}/${taskDetail ? "Y" : "N"} final=[${finalRoles.join(",")}]`,
    );
  }
  return injected as MessageArr;
}

/**
 * Register a session given a resolved agent(+task), fetch details, inject context.
 * Shared by the interactive form path (Case 2) and the header pre-selection path.
 */
export async function completeRegistration(
  resolved: SessionInitData,
  state: SessionInitState,
  cachedTeams: TeamOption[],
  compositeKey: string,
  sessionKey: string,
  userId: string | null,
  config: SessionInitConfig,
  store: SessionStore,
  messages: MessageArr,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
): Promise<SessionInitResult> {
  const regUserId = (state as any).userId || userId;
  if (!regUserId) {
    console.warn(
      `[session-init:cb] session=${compositeKey} no user_id available → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
  }
  // task_id is OPTIONAL for registration: the kernel treats task as an
  // optional business dimension (isolation.ts), so a header-identity agent
  // with team+agent but no task (or a stale task) still registers and gets
  // memory — recall just broadens across the agent's memories instead of
  // narrowing to a task. The interactive "本次不关联任务" / defaultTaskId path
  // also lands here with task_id = defaultTaskId (a virtual value). Do NOT
  // bypass when task_id is missing/undefined.
  const regData = buildRegistrationData(resolved, cachedTeams, sessionKey, regUserId);
  if (!regData) {
    console.warn(
      `[session-init:cb] session=${compositeKey} agent=${resolved.agent_id} not bound to any team → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
  }

  let agentDetail: AgentDetail | null = null;
  let taskDetail: TaskDetail | null = null;

  if (metadataClient) {
    // 当 task_id 是 defaultTaskId（虚拟值）时，跳过 getTask——内核不存在该 task。
    const shouldFetchTask = regData.task_id && regData.task_id !== config.defaultTaskId;
    const [agentRes, taskRes] = await Promise.allSettled([
      metadataClient.getAgent(resolved.agent_id).then((a) => ({
        id: a.agent_id,
        name: a.name,
        description: a.description ?? undefined,
        prompt: a.prompt ?? undefined,
      })),
      shouldFetchTask
        ? metadataClient.getTask(regData.task_id!).then((t) => ({
            id: t.task_id,
            name: t.title,
            description: t.description ?? undefined,
          }))
        : Promise.resolve(null),
    ]);
    if (agentRes.status === "fulfilled") agentDetail = agentRes.value;
    else console.warn(`[session-init:cb] getAgent failed: ${String(agentRes.reason)}`);
    if (taskRes.status === "fulfilled") taskDetail = taskRes.value;
    else console.warn(`[session-init:cb] getTask failed: ${String(taskRes.reason)}`);
  }

  const sessionInfo = buildSessionInfo(regData, userKey, spaceId);
  console.log(
    `[session-init:cb] session=${compositeKey} → initialized ` +
      `agent=${resolved.agent_id} task=${regData.task_id ?? "-"} team=${regData.team_id} user=${sessionInfo.user_id}`,
  );

  // Fire-and-forget: 记录参与日志（对齐 claude-code 分支，源标记为 codebuddy）。
  // bypass 场景已在上方 return，天然被过滤；失败仅 warn，不阻断注入。
  if (
    metadataClient &&
    typeof metadataClient.appendParticipationLog === "function" &&
    regData.task_id
  ) {
    metadataClient
      .appendParticipationLog({
        team_id: regData.team_id,
        task_id: regData.task_id,
        agent_id: regData.agent_id,
        user_id: regData.user_id,
        source: "context_proxy:codebuddy",
      })
      .catch((err: unknown) => {
        console.warn(
          `[session-init:cb] participation-log append failed for session=${compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  const nextState: SessionInitState = {
    status: "initialized",
    keyId: sessionKey,
    startedAt: state.startedAt,
    attemptCount: state.attemptCount,
    sessionInfo,
    userId: regUserId,
    cachedTeams: state.cachedTeams ?? cachedTeams,
    selectedTeamId: state.selectedTeamId,
    agentDetail,
    taskDetail,
    resetFlow: state.resetFlow,
    resetEpoch: state.resetEpoch,
  };
  await store.set(compositeKey, nextState);

  const out = applyArtifactsAndContext(messages, agentDetail, taskDetail, compositeKey, config);
  return {
    intercepted: false,
    messages: out,
    sessionInfo,
    justRegistered: true,
    agentDetail,
    taskDetail,
    resetFlow: state.resetFlow ?? false,
  };
}

// ── Main Handler ───────────────────────────────────────────────────────────────

/**
 * 顶层入口 wrapper：装饰 handleSessionInitInner，在完成后发一条埋点
 * （仅当 prev !== initialized && after === initialized 时）。
 *
 * 埋点装饰绝不改动状态机；失败/异常静默，业务链路零感知。
 * 详见 docs/design/2026-08-03-internal-usage-telemetry-plan.md §7.2。
 */
export async function handleSessionInit(
  sessionKey: string,
  userId: string | null,
  messages: MessageArr,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
  agentSource: string = "codebuddy",
): Promise<SessionInitResult> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  const prevStatus = store.get(compositeKey)?.status ?? "uninitialized";
  try {
    const result = await handleSessionInitInner(
      sessionKey, userId, messages, config, store, reqCtx,
      metadataClient, userKey, spaceId, presetIdentity, agentSource,
    );
    // codex-only 后置增强：把最新 state 里的 codexPageIndex 塞进 formData,
    // 让 codexHandler 的 buildCodexFormResponse 拿到正确的翻页页码。这样
    // handleSessionInitInner 内部所有 return { intercepted: true } 站点都
    // 不用逐个改。CB 客户端会忽略这些字段。
    if (agentSource === "codex" && result.intercepted && result.formData) {
      const latest = store.get(compositeKey);
      if (latest?.codexPageIndex) {
        result.formData = withCodexPageIndex(result.formData, latest.codexPageIndex);
      }
    }
    return result;
  } finally {
    emitSessionInitTelemetryIfCompleted({
      store,
      compositeKey,
      prevStatus,
      agentSource,
    });
  }
}

async function handleSessionInitInner(
  sessionKey: string,
  userId: string | null,
  messages: MessageArr,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
  agentSource: string = "codebuddy",
): Promise<SessionInitResult> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  if (sessionKey === "unknown" || !sessionKey) return { intercepted: false };

  const state = store.get(compositeKey);

  // ── codex-only pre-checks: Default gate + MORE 分页 ───────────────────────
  //
  // 两块识别 CB/CC 客户端永远命不中（DEFAULT_GATE_PREFIX / CODEX_MORE_LABEL
  // 是 codex 客户端专属字符串），因此 opt-in 到 codex source + 有原始 input
  // 才启用；老 CB 用户零回归。
  //
  // isCodexClient (agentSource === "codex") 是"stage 拆分"总闸门：
  //   - 只要是 codex 客户端，session-init 就走两步式 pending_agent_select →
  //     pending_task_select，不再落地老 pending_agent_task。
  //   - CB 客户端一发同时问的 pending_agent_task 路径完全不动。
  // codexInput 检查放到 pre-checks 内，因为只有"当前请求也带答案"时才做
  // gate/MORE 识别；空 input 首帧不需要，但依然按 codex 语义走后续 stage 拆分。
  const codexInput = reqCtx.codexAnswerInput;
  const isCodexClient = agentSource === "codex";
  const isCodexSource = isCodexClient && Array.isArray(codexInput);

  // A. Default 模式 gate —— codex 客户端拦截了 request_user_input 并回填了
  //    "request_user_input is unavailable in Default mode" 字符串。首次命中
  //    落 bypass state + 附带 bypassReason，让 codexHandler 返一次 Plan 模式
  //    提示；后续同 session 请求直接透传（state.bypassed=true 已在 Case 3
  //    分支覆盖）。
  if (isCodexSource && detectCodexDefaultGate(codexInput)) {
    const alreadyBypassed = state?.bypassed === true;
    if (!alreadyBypassed) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state?.startedAt ?? Date.now(),
        attemptCount: state?.attemptCount ?? 0,
        userId: state?.userId ?? (userId ?? undefined),
        cachedTeams: state?.cachedTeams,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(
        `[session-init:cb] session=${compositeKey} codex Default gate → bypass (first hit, notify)`,
      );
      return {
        intercepted: false,
        bypassed: true,
        justRegistered: true,
        bypassReason: "default-gate",
        // codex Default gate 触发时若来自 mem:session-reset,resetFlow 从旧 state 透传出
        // 供 codexHandler 换成"reset 命令需要 Plan 模式"的针对性文案。
        resetFlow: state?.resetFlow ?? false,
      };
    }
    // 已 bypass: fall through, Case 3 会走透传分支
  }

  // B. MORE 翻页 —— 用户点了 "更多..." 选项。CB 状态机自己识别并推进/翻页,
  //    而不是让 codexHandler 独立拦截。判定顺序：先看是否有真答案（partial vs
  //    full MORE），只在 fullMore 时拦截整个请求；partialMore 允许真答案推进
  //    大状态，MORE 那侧在推进后下一 stage 的 form 自动带新 pageIndex。
  if (
    isCodexSource &&
    state &&
    state.status !== "initialized" &&
    state.status !== "uninitialized"
  ) {
    const detection = detectCodexMore(codexInput);
    if (detection.hasMore) {
      // 用 codexFormAnswersAsMessages 转出的文本判断"是否含非 MORE 真答案"
      const answerText = getLastUserMessageText(messages);
      const stripped = answerText.split(CODEX_MORE_LABEL).join("").trim();
      const hasRealAnswer = stripped.length > 0;
      const partialMore = hasRealAnswer && (
        !detection.perQuestion.team_select ||
        !detection.perQuestion.agent_select ||
        !detection.perQuestion.task_select
      );
      // fallbackStage: 纯字符串 MORE 时靠 state.status 反推
      const fallbackStage: "team" | "agent" | "task" | null =
        detection.perQuestion.team_select || detection.perQuestion.agent_select || detection.perQuestion.task_select
          ? null
          : state.status === "pending_team_select"
            ? "team"
            : state.status === "pending_agent_task" || state.status === "pending_agent_select"
              ? "agent"
              : state.status === "pending_task_select"
                ? "task"
                : null;

      const { next, bumped } = computeCodexPageBumps(state.codexPageIndex, detection.perQuestion, fallbackStage);

      if (bumped.length > 0) {
        await store.set(compositeKey, { ...state, codexPageIndex: next });
        console.log(
          `[session-init:cb] session=${compositeKey} codex MORE (${bumped.join(",")}, ${partialMore ? "partial" : "full"}) → ` +
            `teamPage=${next.teamPage} agentPage=${next.agentPage} taskPage=${next.taskPage}`,
        );

        // Full MORE (无真答案) → 拦截整个请求，返当前 stage 的新页 form。
        // Partial MORE (有真答案 + 有 MORE) → 落盘 pageIndex 但继续走 CB 状态机
        // 消费真答案，MORE 侧靠下一 stage form 的 taskPage/agentPage 值重出题。
        if (!partialMore) {
          const cachedTeams = state.cachedTeams ?? [];
          // Stage 依据当前 state.status 反推。拆分后每个 pending_* 都自映射到
          // 自己独立的 stage，回给 codex form 只出该 stage 的 question。
          let stage: FormData["stage"];
          if (state.status === "pending_team_select") stage = "team";
          else if (state.status === "pending_agent_select") stage = "agent_select";
          else if (state.status === "pending_task_select") stage = "task_select";
          else stage = "agent_task"; // legacy pending_agent_task（CB one-shot）
          const fd: FormData = withCodexPageIndex({
            teams: cachedTeams,
            stage,
            selectedTeamId: state.selectedTeamId,
            selectedAgentId: state.selectedAgentId,
            stream: reqCtx.stream,
            questionsAsArray: reqCtx.questionsAsArray,
            modelId: reqCtx.modelId,
            protocol: reqCtx.protocol,
          }, next);
          return { intercepted: true, response: buildFormResponse(fd), formData: fd };
        }
        // partial fall through to state-machine dispatch
      }
    }
  }

  // [session-reset] gate removed: always init on missing state

  // ── DEBUG BYPASS ─────────────────────────────────────────────────────
  // 当 sessionInit.debugForceIdentity 三元组齐全且 state 尚未 initialized 时，
  // 直接以强制身份完成注册，跳过 listTeams / 表单渲染。适用于本地/E2E 测试，
  // 无需依赖 kernel 侧的 team/agent 列表接口。
  // 对所有 agentSource（codebuddy/workbuddy/codex）统一生效。
  if (
    config.debugForceIdentity &&
    userId &&
    metadataClient &&
    (!state || state.status !== "initialized")
  ) {
    const forced = config.debugForceIdentity;
    console.log(
      `[session-init:cb] session=${compositeKey} DEBUG bypass — force identity ` +
        `team=${forced.team_id} agent=${forced.agent_id} task=${forced.task_id ?? "-"} user=${userId}`,
    );
    const forcedTeams: TeamOption[] = [
      {
        team_id: forced.team_id,
        team_name: forced.team_id,
        agents: [
          { agent_id: forced.agent_id, agent_name: forced.agent_id } as any,
        ],
        tasks: forced.task_id
          ? [{ task_id: forced.task_id, task_name: forced.task_id } as any]
          : [],
      } as TeamOption,
    ];
    const seededState: SessionInitState = (state ?? {
      status: "uninitialized",
      keyId: sessionKey,
      startedAt: Date.now(),
      attemptCount: 0,
      userId,
    }) as SessionInitState;
    return await completeRegistration(
      { agent_id: forced.agent_id, task_id: forced.task_id } as any,
      seededState,
      forcedTeams,
      compositeKey,
      sessionKey,
      userId,
      config,
      store,
      messages,
      metadataClient,
      userKey,
      spaceId,
    );
  }

  // ── Case 1: Uninitialized → 先弹 asset_confirm 对话框 ───────────────────
  if (!state || state.status === "uninitialized") {
    if (!userId) {
      console.warn(
        `[session-init:cb] session=${compositeKey} no userId, passing through unintercepted`,
      );
      return { intercepted: false };
    }
    if (!metadataClient) {
      console.warn(
        `[session-init:cb] session=${compositeKey} no metadataClient, passing through unintercepted`,
      );
      return { intercepted: false };
    }

    let teams: TeamOption[];
    try {
      const cfg = await fetchTeamsAndAgents(userId, config, metadataClient);
      teams = cfg.teams;
    } catch (err) {
      console.warn(
        `[session-init:cb] session=${compositeKey} kernel unavailable for user=${userId}, passing through unintercepted: ${err instanceof Error ? err.message : String(err)}`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const totalAgents = teams.reduce((acc, t) => acc + t.agents.length, 0);
    if (totalAgents === 0) {
      console.warn(
        `[session-init:cb] session=${compositeKey} user=${userId} has no active agents, passing through`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        cachedTeams: teams,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    // ── Header-driven pre-selection: skip forms when identity is provided ──
    if (presetIdentity && config.headerAutoSelect?.enabled) {
      const pr = resolvePresetIdentity(teams, presetIdentity);

      if (pr.hadMismatch) {
        if (config.headerAutoSelect.onMismatch === "bypass") {
          console.warn(`[session-init:cb] session=${compositeKey} preset mismatch → bypass`);
          await store.set(compositeKey, {
            status: "initialized",
            keyId: sessionKey,
            startedAt: Date.now(),
            attemptCount: 0,
            userId,
            cachedTeams: teams,
            sessionInfo: null,
            agentDetail: null,
            taskDetail: null,
            bypassed: true,
          } as SessionInitState);
          return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
        }
        console.warn(`[session-init:cb] session=${compositeKey} preset mismatch → fallback to form`);
        // fall through to the normal asset_confirm flow below
      } else if (pr.canRegister) {
        // team + agent resolved → register directly (task optional). A missing
        // task_id yields undefined → broad recall across the agent's memories;
        // a stale (unknown) task_id was already dropped by resolvePresetIdentity
        // (not echoed back) — warn so the operator can re-point the client.
        if (presetIdentity?.taskId && !pr.taskId) {
          console.warn(
            `[session-init:cb] session=${compositeKey} preset task_id="${presetIdentity.taskId}" not found in team=${pr.teamId} → registering without a task (broad recall)`,
          );
        }
        console.log(
          `[session-init:cb] session=${compositeKey} preset hit team=${pr.teamId} agent=${pr.agentId} task=${pr.taskId ?? "-"} → register directly`,
        );
        const seedState: SessionInitState = {
          status: "uninitialized",
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: pr.teamId,
        };
        return completeRegistration(
          { agent_id: pr.agentId!, task_id: pr.taskId },
          seedState, teams, compositeKey, sessionKey, userId,
          config, store, messages, metadataClient, userKey, spaceId,
        );
      } else if (pr.teamId) {
        // only team resolved → jump straight to agent+task selection (skip
        // asset_confirm + team_select). codex/WB/dsh/opencode 走两步 stage 拆分，先 agent_select；
        // CB 客户端保持老 pending_agent_task 一发同时问的语义。
        //
        // opencode 说明：opencode 客户端原生 `question` tool 每次只能弹一个题，
        // 无法承载"同时问 agent+task"的语义，必须拆 stage（同 codex/wb/dsh）。
        const nextStatus = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "pending_agent_select" : "pending_agent_task";
        const nextStage: FormData["stage"] = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "agent_select" : "agent_task";
        await store.set(compositeKey, {
          status: nextStatus,
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: pr.teamId,
        });
        console.log(
          `[session-init:cb] session=${compositeKey} preset team=${pr.teamId} → ${nextStatus}`,
        );
        const fd: FormData = {
          teams,
          stage: nextStage,
          selectedTeamId: pr.teamId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    // 先弹 asset_confirm 对话框
    await store.set(compositeKey, {
      status: "pending_asset_confirm",
      keyId: sessionKey,
      startedAt: Date.now(),
      attemptCount: 0,
      userId,
      cachedTeams: teams,
    });
    console.log(
      `[session-init:cb] session=${compositeKey} user=${userId} → pending_asset_confirm (teams=${teams.length})`,
    );
    const fd: FormData = {
      teams,
      stage: "asset_confirm",
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 1.25: Awaiting asset_confirm ────────────────────────────────────
  if (state.status === "pending_asset_confirm") {
    const lastUserText = getLastUserMessageText(messages);
    const choice = extractAssetConfirm(lastUserText);
    if (config.debugVerboseLogging) {
      console.log(
        `[session-init:cb-debug] asset_confirm session=${compositeKey} choice=${choice} lastUserText=${JSON.stringify(lastUserText).slice(0, 300)}`,
      );
    }

    if (choice === false) {
      // bypass: 用户明确选择"不关联" —— 保留 form 对话原样，不删。
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: state.attemptCount,
        userId: state.userId,
        cachedTeams: state.cachedTeams,
        selectedTeamId: undefined,
        agentDetail: null,
        taskDetail: null,
        sessionInfo: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} user chose no-asset → bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (choice === true) {
      const teams = state.cachedTeams ?? [];
      if (teams.length === 1) {
        const onlyTeam = teams[0];
        // 递进 auto-select：team=1 时若 agent 也只有 1 个，直接跳过 agent form；
        // task 只有 1 个再进一步 auto-select，避免 form 出现 solo-page 断言。
        // 这个链路对 CB / WB / codex 都通用（CB 老路径原本会在 agent_task
        // 一发同时问，但 agent 只有 1 个时同样应跳过）。
        if (onlyTeam.agents.length === 1) {
          const soloAgent = onlyTeam.agents[0];
          const nextState: SessionInitState = {
            ...state,
            status: "pending_agent_select" as any,
            keyId: sessionKey,
            attemptCount: 0,
            cachedTeams: teams,
            selectedTeamId: onlyTeam.team_id,
            selectedAgentId: soloAgent.agent_id,
          };
          console.log(
            `[session-init:cb] session=${compositeKey} only-team=${onlyTeam.team_id} only-agent=${soloAgent.agent_id} auto-select`,
          );
          // 0 tasks → bypass；1 task → 直接 completeRegistration；≥2 → 出 task form。
          if (onlyTeam.tasks.length === 0) {
            await store.set(compositeKey, {
              ...nextState,
              status: "initialized",
              sessionInfo: null,
              agentDetail: null,
              taskDetail: null,
              bypassed: true,
            } as SessionInitState);
            console.log(
              `[session-init:cb] session=${compositeKey} team has 0 tasks → bypass`,
            );
            return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
          }
          if (onlyTeam.tasks.length === 1) {
            const soleTaskId = onlyTeam.tasks[0].task_id;
            console.log(
              `[session-init:cb] session=${compositeKey} auto-select single task=${soleTaskId} → completeRegistration`,
            );
            return await completeRegistration(
              { agent_id: soloAgent.agent_id, task_id: soleTaskId },
              nextState, teams, compositeKey, sessionKey, userId,
              config, store, messages, metadataClient, userKey, spaceId,
            );
          }
          // ≥2 tasks：切到 task_select stage 出 task form。
          await store.set(compositeKey, {
            ...nextState,
            status: "pending_task_select",
          });
          console.log(
            `[session-init:cb] session=${compositeKey} → pending_task_select (tasks=${onlyTeam.tasks.length})`,
          );
          const fd: FormData = {
            teams,
            stage: "task_select",
            selectedTeamId: onlyTeam.team_id,
            selectedAgentId: soloAgent.agent_id,
            stream: reqCtx.stream,
            questionsAsArray: reqCtx.questionsAsArray,
            modelId: reqCtx.modelId,
            protocol: reqCtx.protocol,
          };
          return { intercepted: true, response: buildFormResponse(fd), formData: fd };
        }

        // ≥2 agents：CB 老路径 pending_agent_task 一发同时问；codex/WB/dsh/opencode 拆 stage
        // 走 pending_agent_select。WB 的 form 本来就按 CC 风格拆开问，让它走
        // codex 分支，避免落到 legacy agent_task stage 后 form 里只问 agent
        // 却按老语义处理的语义歧义。opencode 原生 `question` tool 每次只能弹
        // 一个题，也必须走 split stage。
        const useSplitStage = isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode";
        const nextStatus = useSplitStage ? "pending_agent_select" : "pending_agent_task";
        const nextStage: FormData["stage"] = useSplitStage ? "agent_select" : "agent_task";
        await store.set(compositeKey, {
          status: nextStatus,
          keyId: sessionKey,
          startedAt: state.startedAt,
          attemptCount: 0,
          userId: state.userId,
          cachedTeams: teams,
          selectedTeamId: onlyTeam.team_id,
        });
        console.log(
          `[session-init:cb] session=${compositeKey} only-team=${onlyTeam.team_id} → ${nextStatus}`,
        );
        const fd: FormData = {
          teams,
          stage: nextStage,
          selectedTeamId: onlyTeam.team_id,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }

      await store.set(compositeKey, {
        status: "pending_team_select",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams: teams,
      });
      console.log(
        `[session-init:cb] session=${compositeKey} → pending_team_select (teams=${teams.length})`,
      );
      const fd: FormData = {
        teams,
        stage: "team",
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} asset-confirm max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "asset_confirm",
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 1.5: Awaiting team selection ─────────────────────────────────────
  if (state.status === "pending_team_select") {
    const lastUserText = getLastUserMessageText(messages);
    const teamId = extractTeamFromOptionText(lastUserText, state.cachedTeams ?? []);

    // 用户在 team_select 阶段用 SKIP_RE (跳过/不关联/skip) 主动 bypass
    // (P1-4 修复)。对齐 pending_agent_select (init.ts:922) / pending_task_select
    // (init.ts:1037) 的 BYPASS_MARKER 分支姿势 —— 老代码这里漏写, 导致 SKIP
    // 词被当"未识别"计入 attemptCount, 3 次才 maxRetries 强制 bypass。
    if (teamId === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams: state.cachedTeams ?? [],
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} team_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (teamId && teamId !== BYPASS_MARKER) {
      // codex/WB/dsh/opencode 拆 stage：先 agent_select → task_select；CB 老路径继续 agent_task 一发同时问。
      const nextStatus = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "pending_agent_select" : "pending_agent_task";
      const nextStage: FormData["stage"] = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "agent_select" : "agent_task";
      const next: SessionInitState = {
        ...state,
        status: nextStatus,
        selectedTeamId: teamId,
        attemptCount: 0,
      };
      await store.set(compositeKey, next);
      console.log(`[session-init:cb] session=${compositeKey} team=${teamId} → ${nextStatus}`);
      const fd: FormData = {
        teams: state.cachedTeams ?? [],
        stage: nextStage,
        selectedTeamId: teamId,
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} team-select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "team",
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2a (codex-only): Awaiting agent selection ────────────────────────
  //
  // codex 客户端专属分支。用户在 agent_select stage 选完 agent → 推进 task_select
  // stage（若 team 只有 1 个 task 则 auto-select 直接 complete）。
  // CB 客户端永远不进入此分支。
  if (state.status === "pending_agent_select") {
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;
    const team = cachedTeams.find((t) => t.team_id === selectedTeamId);
    if (!team) {
      console.warn(
        `[session-init:cb] session=${compositeKey} pending_agent_select but team=${selectedTeamId} not in cache → bypass`,
      );
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const lastUserText = getLastUserMessageText(messages);

    // ── WorkBuddy-only: MORE 翻页拦截 ──
    // WorkBuddy 复用 CB 状态机 + workbuddy/form.ts 的分页 form（MORE_LABEL="更多 →"）。
    // extractAgentOnly 不识别 MORE，必须在其之前拦截，否则点"更多 →"会被当未识别 →
    // 无限重发第 1 页。命中则 bump agentPage 并重发 agent_select form（页码经
    // session/index.ts 的 workbuddy/opencode 重渲染分支按 stage 从 codexPageIndex.agentPage 挑出）。
    // opencode 与 workbuddy 共用 `更多 →` MORE_LABEL 与分页语义，一并拦截。
    if (agentSource === "workbuddy" || agentSource === "opencode") {
      const curAgentPage = state.codexPageIndex?.agentPage ?? 0;
      const nextAgentPage = detectWorkbuddyMorePage(lastUserText, curAgentPage, team.agents.length);
      if (nextAgentPage !== null) {
        const nextPx = {
          teamPage: state.codexPageIndex?.teamPage ?? 0,
          agentPage: nextAgentPage,
          taskPage: state.codexPageIndex?.taskPage ?? 0,
        };
        await store.set(compositeKey, { ...state, codexPageIndex: nextPx });
        console.log(
          `[session-init:cb] session=${compositeKey} WB agent MORE page ${curAgentPage} → ${nextAgentPage}`,
        );
        const fd: FormData = withCodexPageIndex({
          teams: cachedTeams,
          stage: "agent_select",
          selectedTeamId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        }, nextPx);
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    const picked = extractAgentOnly(lastUserText, cachedTeams, selectedTeamId);

    if (picked === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams,
        selectedTeamId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} agent_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (picked) {
      const resolvedAgentId = resolveAgent(picked, cachedTeams, selectedTeamId);
      // 0 tasks → bypass；1 task → auto-select 直接 complete。
      if (team.tasks.length === 0) {
        console.log(
          `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} team has 0 tasks → bypass`,
        );
        await store.set(compositeKey, {
          status: "initialized",
          keyId: sessionKey,
          startedAt: state.startedAt,
          attemptCount: 0,
          userId: state.userId,
          cachedTeams,
          selectedTeamId,
          selectedAgentId: resolvedAgentId,
          sessionInfo: null,
          agentDetail: null,
          taskDetail: null,
          bypassed: true,
        } as SessionInitState);
        return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
      }
      if (team.tasks.length === 1) {
        const soleTaskId = team.tasks[0].task_id;
        console.log(
          `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} auto-select single task=${soleTaskId}`,
        );
        return await completeRegistration(
          { agent_id: resolvedAgentId, task_id: soleTaskId },
          state, cachedTeams, compositeKey, sessionKey, userId,
          config, store, messages, metadataClient, userKey, spaceId,
        );
      }
      // ≥2 tasks → 进 task_select stage 出下一 form。
      const nextState: SessionInitState = {
        ...state,
        status: "pending_task_select",
        selectedAgentId: resolvedAgentId,
        attemptCount: 0,
        // 进新 stage 时清掉 task 页码，从第 1 页开始翻。agentPage 已用完可保留可清；
        // 保留无副作用，清了更干净——统一清成 0。
        codexPageIndex: { teamPage: state.codexPageIndex?.teamPage ?? 0, agentPage: 0, taskPage: 0 },
      };
      await store.set(compositeKey, nextState);
      console.log(
        `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} → pending_task_select (tasks=${team.tasks.length})`,
      );
      const fd: FormData = {
        teams: cachedTeams,
        stage: "task_select",
        selectedTeamId,
        selectedAgentId: resolvedAgentId,
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    // Extraction failed → retry / bypass。
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} agent_select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: cachedTeams,
      stage: "agent_select",
      selectedTeamId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2b (codex-only): Awaiting task selection ────────────────────────
  if (state.status === "pending_task_select") {
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;
    const selectedAgentId = state.selectedAgentId;
    const team = cachedTeams.find((t) => t.team_id === selectedTeamId);
    if (!team || !selectedAgentId) {
      console.warn(
        `[session-init:cb] session=${compositeKey} pending_task_select missing team/agent (team=${selectedTeamId} agent=${selectedAgentId}) → bypass`,
      );
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const lastUserText = getLastUserMessageText(messages);

    // ── WorkBuddy-only: MORE 翻页拦截 ──
    // 同 pending_agent_select：extractTaskOnly 不识别 "更多 →"，必须先拦截。命中则
    // bump taskPage 并重发 task_select form（页码经 session/index.ts 的 workbuddy/opencode
    // 重渲染分支按 stage 从 codexPageIndex.taskPage 挑出）。
    if (agentSource === "workbuddy" || agentSource === "opencode") {
      const curTaskPage = state.codexPageIndex?.taskPage ?? 0;
      const nextTaskPage = detectWorkbuddyMorePage(lastUserText, curTaskPage, team.tasks.length);
      if (nextTaskPage !== null) {
        const nextPx = {
          teamPage: state.codexPageIndex?.teamPage ?? 0,
          agentPage: state.codexPageIndex?.agentPage ?? 0,
          taskPage: nextTaskPage,
        };
        await store.set(compositeKey, { ...state, codexPageIndex: nextPx });
        console.log(
          `[session-init:cb] session=${compositeKey} WB task MORE page ${curTaskPage} → ${nextTaskPage}`,
        );
        const fd: FormData = withCodexPageIndex({
          teams: cachedTeams,
          stage: "task_select",
          selectedTeamId,
          selectedAgentId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        }, nextPx);
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    const picked = extractTaskOnly(lastUserText, cachedTeams, selectedTeamId);

    if (picked === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams,
        selectedTeamId,
        selectedAgentId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} task_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (typeof picked === "string") {
      // 命中 task_id（含 defaultTaskId 虚拟条目）→ complete。
      return await completeRegistration(
        { agent_id: selectedAgentId, task_id: picked },
        state, cachedTeams, compositeKey, sessionKey, userId,
        config, store, messages, metadataClient, userKey, spaceId,
      );
    }

    // 未识别 → retry / bypass。
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} task_select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: cachedTeams,
      stage: "task_select",
      selectedTeamId,
      selectedAgentId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2: Awaiting agent + task selection ───────────────────────────────
  if (state.status === "pending_agent_task" || state.status === "pending_form") {
    const lastUserText = getLastUserMessageText(messages);
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;

    // LLM-based extraction fallback was removed — engineered paths only.
    // If neither the option-text match nor the structured parser recognises
    // the reply, the caller falls through to the retry / bypass branch.
    let extracted = extractFromOptionText(lastUserText, cachedTeams, selectedTeamId)
      ?? extractStructured(lastUserText);

    if (extracted && extracted.agent_id === BYPASS_MARKER) {
      console.warn(`[session-init:cb] session=${compositeKey} unexpected bypass in agent_task, treating as extraction failure`);
      extracted = null;
    }

    if (extracted) {
      const resolvedAgentId = resolveAgent(extracted.agent_id, cachedTeams, selectedTeamId);
      const resolvedTaskId = resolveTask(
        extracted.task_id,
        cachedTeams,
        resolvedAgentId,
        selectedTeamId,
      );
      const resolved: SessionInitData = {
        agent_id: resolvedAgentId,
        task_id: resolvedTaskId,
      };

      return await completeRegistration(
        resolved, state, cachedTeams, compositeKey, sessionKey, userId,
        config, store, messages, metadataClient, userKey, spaceId,
      );
    }

    // Extraction failed → retry / reset
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "agent_task",
      selectedTeamId: state.selectedTeamId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 3: Initialized ───────────────────────────────────────────────────
  const bypassed = (state as any).bypassed === true;
  const agent = bypassed ? null : (state.agentDetail ?? null);
  const task = bypassed ? null : (state.taskDetail ?? null);
  const out = applyArtifactsAndContext(messages, agent, task, sessionKey, config);
  return { intercepted: false, messages: out, sessionInfo: state.sessionInfo, bypassed };
}