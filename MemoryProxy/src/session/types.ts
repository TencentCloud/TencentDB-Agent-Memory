/**
 * Session initialization types.
 */

/**
 * 用于 `config.defaultTaskId` 兜底关联时，fetchTeamsAndAgents 在每个 team 的
 * tasks 列表头部注入的虚拟条目 label。
 *
 * 通过在源头注入而不是在 form / extractor 侧加分支，让分页 total、auto-select
 * 级联、extractor 匹配全部走既有 tasks.length 路径，避免"分页真相分散"型 bug
 * （见 docs 里 defaultTaskId 相关记录 & 2026-07-29 issue）。
 */
export const DEFAULT_TASK_LABEL = "本次不关联任务";

/**
 * Session-init 状态机：
 *   uninitialized           → 第一次进来，控制面拉 teams[]
 *   pending_asset_confirm   → 已发轮0 form（是否关联团队资产），等用户答
 *   pending_team_select     → 已选"是"，已发轮1 form（只问 team），等用户答
 *   pending_agent_task      → 已选 team，已发轮2 form（agent + task），等用户答
 *   initialized             → 已识别完整三元组，登记完成
 *
 * 当 teams.length === 1 时跳过 pending_team_select，直接进入 pending_agent_task。
 * 用户在 pending_asset_confirm 阶段选"否"时直接 bypass。
 */
export type SessionInitStatus =
  | "uninitialized"
  | "pending_asset_confirm"
  | "pending_team_select"
  | "pending_agent_task"     // legacy
  | "pending_agent_select"  // CC: selecting agent (with pagination)
  | "pending_task_select"   // CC: selecting task (with pagination)
  | "initialized"
  // legacy（一期单 form），保留以兼容旧测试 / 旧 store 数据
  | "pending_form";

export interface SessionInitState {
  status: SessionInitStatus;
  keyId: string;
  startedAt: number;
  attemptCount: number;
  sessionInfo?: SessionInfo | null;
  /** User ID from auth/verify (not from header). */
  userId?: string;
  /** 内核 /teams 返回的嵌套结构，用于渲染 form 与解析用户答复。 */
  cachedTeams?: TeamOption[];
  /**
   * 用户已在轮1 选定的 team_id（pending_agent_task 阶段才有意义）。
   * 轮2 form 仅渲染该 team 下的 agents/tasks；extractor 也只在该 team 内匹配。
   */
  selectedTeamId?: string;
  /**
   * Claude Code 分页模式下的当前 agent 页码（0-based）。
   *
   * 背景：Claude Code 的 AskUserQuestion 单 question 限制 2–4 选项，当某 team
   * 下 agent 数量超过 3 个时无法一次性铺开。我们沿用现有"多轮拦截"机制，每
   * 渲染 3 个 agent + 1 个"更多→"或"本次不关联"槽位，用户点"更多"则 pageIndex++
   * 再发下一页 form。详见 docs/reports/2026-06-19-cc-form-mode-experiment.md §4.4。
   *
   * - 仅 Claude Code（agentSource="claude-code"）使用，CodeBuddy 走 ask_followup_question
   *   没有 4 选项限制，无需分页。
   * - 仅在 status="pending_agent_task" 期间有效。
   * - 默认 0（首页）；每次用户选"更多"，handler 把它 +1 重发 form。
   */
  agentPageIndex?: number;
  /** CC: 用户在 agent_select 阶段选定的 agent_id（用于 pending_task_select 阶段）。 */
  selectedAgentId?: string;
  /** Resolved agent detail (cached after selection), used to inject context every request. */
  agentDetail?: AgentDetail | null;
  /** Resolved task detail (cached after selection), used to inject context every request. */
  taskDetail?: TaskDetail | null;
  /**
   * 用户明确选择了"跳过"（本次不关联）。状态设为 initialized 防止重复弹窗，
   * 但 agentDetail/taskDetail 为 null，后续请求只 strip 不 inject。
   */
  bypassed?: boolean;
  /**
   * codex 客户端专属分页页码（0-based），只在 agentSource="codex" 场景写入。
   *
   * 背景：codex 的 request_user_input 单 question 最多 3 个 option（客户端会
   * 自动追加"其他"占 1 位，proxy 不能自己塞）。当候选 > 3 时按 3-slot 上限
   * 分页：前 N-1 页各 2 real + "更多..."，末页 2~3 real。
   *
   * 独立于 CC 侧的 `agentPageIndex` —— CC 有自己的 4-slot 分页语义 (agent /
   * task 共用一个字段，靠 stage 区分)，codex 需要 team / agent / task 三段
   * 独立页码, 复用会互串。
   *
   * ── 谁写入 ──
   * CB 状态机在 agentSource==="codex" + reqCtx.codexAnswerInput 命中 MORE 时
   * bump 对应字段（团队规范 2026-08-08 codex session-init 重构：MORE 拦截从
   * codexHandler 收敛到 CB 状态机内部）。CC/普通 CB 场景永远不写。
   */
  codexPageIndex?: {
    teamPage?: number;
    agentPage?: number;
    taskPage?: number;
  };
  /**
   * Transient (not persisted): source hint set by SessionStore.getOrRecover
   * indicating which cache layer produced this state on the current turn.
   *
   * - `l1`: hot in-memory hit — hook-cache is almost certainly also warm in
   *   this process. Handler should NOT trigger prewarm.
   * - `l2a`: SessionRepo hit — same-process cache exists too (state promoted
   *   back to L1 in probeL2a); handler should NOT trigger prewarm.
   * - `l2b`: rebuilt from binding after L1+L2a miss — hook-cache may be
   *   cold (fresh pod / long dormant session). Handler SHOULD prewarm.
   * - `history-scan`: last-resort bypass reconstruction — hook-cache is
   *   also cold. Handler SHOULD prewarm.
   *
   * Consumed by handler.ts / anthropicHandler.ts to decide `justRegistered`
   * without triggering redundant network fetches on every warm turn.
   *
   * Not written by set()/upsert()/repo callers — only meaningful on the
   * getOrRecover return value; do not persist to L2a/L2b.
   */
  __recoverySource?: "l1" | "l2a" | "l2b" | "history-scan";

  /** mem:session-reset 触发时写入，标记本次 init 是 reset 流程。 */
  resetFlow?: boolean;
  /** mem:session-reset 触发的时间戳，跨节点一致性校验用。 */
  resetEpoch?: number;
}

/**
 * 来自控制面 `/api/v1/proxy/resources` 的嵌套结构：
 *   teams[] → agents[]  +  tasks[]
 *
 * agents 和 tasks 是该 team 下的完整列表，平级展示。
 * session init 时用户自由选择 agent + task，task_agents 关联关系
 * 在 init 完成后由页面管理，不影响 init 时的选项列表。
 */
export interface TaskInTeam {
  task_id: string;
  task_name: string;
  /**
   * 标识该条目是 `config.defaultTaskId` 兜底注入的虚拟 task（source: proxy）
   * 而非内核里真实存在的 task。form 侧看到该字段会跳过 `(id-suffix)` 的拼接，
   * 显示更干净的 label —— 反正虚拟 task 只有一个，不存在重名歧义。
   */
  isDefault?: boolean;
}

export interface AgentInTeam {
  agent_id: string;
  agent_name: string;
  description?: string;
}

export interface TeamOption {
  team_id: string;
  team_name: string;
  agents: AgentInTeam[];
  tasks: TaskInTeam[];
}

/** @deprecated 旧扁平结构，保留以兼容旧测试；新代码用 TeamOption。 */
export interface AgentOption {
  id: string;
  name: string;
  description?: string;
  team_id?: string;
}

/** @deprecated 旧扁平结构，保留以兼容旧测试；新代码用 TaskInTeam。 */
export interface TaskOption {
  id: string;
  name: string;
  description?: string;
}

/** Full Agent detail (fetched after selection) — content injected into system prompt. */
export interface AgentDetail {
  id: string;
  name: string;
  description?: string;
  /** The Agent's system-level prompt / persona, appended to system message. */
  prompt?: string;
}

/** Full Task detail (fetched after selection) — content injected into system prompt. */
export interface TaskDetail {
  id: string;
  name: string;
  description?: string;
  /** Optional structured goal/acceptance criteria text. */
  goal?: string;
}

/**
 * User-facing init data — agent + task selection (from dropdown).
 * team_id and user_id are sourced from the selected agent and the request
 * header respectively; not part of the user-facing form.
 */
export interface SessionInitData {
  agent_id: string;
  /** User-selected task (index into cachedTasks, or raw task_id string). */
  task_id?: string;
}

/** Full init data sent to register session. */
export interface SessionRegistrationData {
  team_id: string;
  agent_id: string;
  user_id: string;
  task_id?: string;
  session_id: string;
}

/**
 * Subset of the `POST /agent-sessions` response we consume.
 * The real backend returns more (created_at, updated_at, …) — we keep the
 * shape loose with `permissions` etc. optional so future fields don't break us.
 */
export interface SessionInfo {
  session_id: string;
  team_id: string;
  agent_id: string;
  user_id: string;
  task_id?: string;
  /** User's API key — stored so injectors can create MetadataClient for per-user kernel calls. */
  user_key?: string;
  /**
   * Kernel instance / space ID (e.g. `mem-example001`) extracted from the request
   * URL path `/proxy/<spaceId>/...`. Stored so injectors can build a
   * MetadataClient with the correct `x-tdai-service-id` header (kernel routes
   * tenants by this header — a static config value would return `invalid_user_key`).
   */
  space_id?: string;
  created_at?: string;
  expires_at?: string;
  identity_verified?: boolean;
  permissions?: {
    user_in_team?: boolean;
    user_in_task?: boolean;
    agent_assigned_to_task?: boolean;
    repo_in_team?: boolean;
  };
  fixed_asset_summary?: {
    count: number;
    total_est_tokens: number;
  };
}
