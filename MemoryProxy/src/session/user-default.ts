/**
 * resolveUserSessionDefault — session-init 时的"账户级默认配置"解析器。
 *
 * 对应设计文档: docs/design/2026-10-10-user-session-default-design.md §5.2。
 *
 * 职责:
 *   1. 查询用户的 user session default (Core: /v3/meta/user-session-default/get)
 *   2. 对查询结果做"读时懒校验":
 *      - team_id 必须在当前拉到的 teams[] 里 (保证 user 还是成员)
 *      - agent_id 必须在该 team.agents[] 里 (保证 agent 未删/未停用)
 *      - task_id === DEFAULT_TASK_SENTINEL ("default") 虚拟值 → 直接通过
 *      - task_id 为真实 id → 必须在 team.tasks[] 里 (保证 task 未删除)
 *   3. 任一环节失败 (包括 RPC 异常) → 返 null, 让 caller 回退到 header preset
 *      → 原交互表单。**绝不抛错到调用点**, 保证"账户默认失效"路径与"没配默认"
 *      路径对用户无差别。
 *
 * 优先级 (设计文档 §2.2):
 *   账户默认 > header preset > 交互表单
 *
 * 返回值契约与 header preset 的 `resolvePresetIdentity` 保持一致 (返
 * `PresetResolution`), 下游 completeRegistration 不区分两种来源 ——
 * fastRegister 产出的 SessionInfo 字节完全同构。
 */

import type { TeamOption, AgentDetail, TaskDetail } from "./types.js";
import type { PresetResolution } from "./preset.js";
import type { MetadataClient } from "../meta/client.js";

export interface ResolveUserSessionDefaultInput {
  userId: string | null;
  teams: TeamOption[];
  metadataClient: MetadataClient;
  /** 用于日志标记; 不参与业务逻辑。 */
  compositeKey: string;
  /**
   * Proxy 当前配置的 `sessionInit.defaultTaskId` 字面量 (通常是 "default")。
   * 从 user_session_default 读到的 task_id 若等于这个字面量, 跳过存在性校验。
   */
  defaultTaskId: string | undefined;
}

/** Prefix for structured logs (grep-friendly)。 */
const TAG = "[session-init:user-default]";

/**
 * v3.3 埋点需要的 fallback 原因枚举。resolver 返回 null 时同步给调用点,
 * 让 handleSessionInit 把它落到 state.defaultFallbackReason, 进而被
 * emitSessionInitTelemetryIfCompleted 读到并写入 ClickHouse。
 *
 * - "": 没查到配置 (正常未设置, 不是失败)
 * - "get_failed": Core RPC 异常 (网络 / 鉴权 / 500)
 * - "team_not_accessible" / "agent_not_accessible" / "task_not_accessible":
 *   懒校验的三类失败, 和设计文档 §4.5 的 error code 对称。
 */
export type UserDefaultFallbackReason =
  | ""
  | "get_failed"
  | "team_not_accessible"
  | "agent_not_accessible"
  | "task_not_accessible";

/**
 * resolver 的完整结果, 区分三类终态:
 *   - hit:   命中账户默认, 可直接 fastRegister
 *   - miss:  没配 / 读失败 / 校验失败, 走回退 (header → form)
 *   - empty: 入参缺 userId, 完全不参与
 *
 * resolution 与 fallbackReason 互斥: 命中时后者为 ""; 失败时前者为 null。
 */
export interface UserDefaultResolveResult {
  resolution: PresetResolution | null;
  fallbackReason: UserDefaultFallbackReason;
}

/**
 * 把 fallbackReason 翻译成**给用户看**的中文说明。
 *
 * PRD "Session Init 逻辑" 第 3 条: "配置已失效或无权限: 不使用该配置, **提示原因**
 * 并回退到手动选择。" —— 之前实现只静默回退 (设计文档 §1.2 的口径), 用户完全
 * 不知道自己的默认配置为什么没生效。这里补上"提示原因"这一半。
 *
 * 返回 null 表示该原因**不需要打扰用户**:
 *   - ""            本来就没配默认, 是正常的首次流程, 提示反而是噪音;
 *   - "get_failed"  Core RPC 异常 (网络/鉴权/500), 属系统侧瞬时故障, 用户读了
 *                   也无能为力, 且回退后表单照常可用。仅在日志+埋点里留痕。
 */
export function describeUserDefaultFallback(
  reason: UserDefaultFallbackReason,
): string | null {
  switch (reason) {
    case "team_not_accessible":
      return "你设置的默认 Team 已不可访问（可能已退出该团队或团队被删除），本次改为手动选择。";
    case "agent_not_accessible":
      return "你设置的默认 Agent 已不可访问（可能已被停用或删除），本次改为手动选择。";
    case "task_not_accessible":
      return "你设置的默认 Task 已不可访问（可能已被删除或已结束），本次改为手动选择。";
    case "get_failed":
    case "":
      return null;
    default:
      return null;
  }
}

export async function resolveUserSessionDefault(
  input: ResolveUserSessionDefaultInput,
): Promise<UserDefaultResolveResult> {
  if (!input.userId) return { resolution: null, fallbackReason: "" };

  // Step 1: 读 Core
  let def;
  try {
    def = await input.metadataClient.getUserSessionDefault(input.userId);
  } catch (err) {
    console.warn(
      `${TAG} session=${input.compositeKey} user=${input.userId} get failed, fallback: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return { resolution: null, fallbackReason: "get_failed" };
  }
  if (!def) {
    // 未设置默认, 走原流程。不打 log (正常路径, 避免噪音)。
    return { resolution: null, fallbackReason: "" };
  }

  // Step 2: 校验 team 在当前 teams[] 里 (listTeams 已经隐式帮我们过滤了"user
  // 是否 team 成员")
  const team = input.teams.find((t) => t.team_id === def.team_id);
  if (!team) {
    console.warn(
      `${TAG} session=${input.compositeKey} user=${input.userId} fallback_reason=team_not_accessible team_id=${def.team_id}`,
    );
    return { resolution: null, fallbackReason: "team_not_accessible" };
  }

  // Step 3: 校验 agent 可见性 —— 与 Core 保存端 (user-session-default-service.set)
  // 的口径**严格对齐**: owner==self 或 visibility==team。
  //
  // ⚠️ 不能用 team.agents (它来自 listAgents(teamId, userId), 只含 owner=self)：
  // Core 保存时允许选 team 可见的、别人 owner 的 agent，若这里只认 owner=self，
  // 会出现"存得进、读不出"——默认配置保存成功但每次新 session 都 agent_not_accessible
  // 回退表单 (实测踩过: admin 的 default-agent-admin visibility=team 被误判不可见)。
  //
  // 因此这里单独拉一次 **team 全量 active agent** (listAgents 不传 owner 即全量),
  // 再按 owner / visibility 判定。
  let agentsAll: Awaited<ReturnType<MetadataClient["listAgents"]>>;
  try {
    agentsAll = await input.metadataClient.listAgents(def.team_id);
  } catch (err) {
    console.warn(
      `${TAG} session=${input.compositeKey} user=${input.userId} fallback_reason=agent_not_accessible (listAgents failed): ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return { resolution: null, fallbackReason: "agent_not_accessible" };
  }
  const agent = agentsAll.find((a) => a.agent_id === def.agent_id);
  const agentAccessible =
    !!agent &&
    agent.status === "active" &&
    (agent.owner_user_id === input.userId || agent.visibility === "team");
  if (!agentAccessible) {
    console.warn(
      `${TAG} session=${input.compositeKey} user=${input.userId} fallback_reason=agent_not_accessible team_id=${def.team_id} agent_id=${def.agent_id}`,
    );
    return { resolution: null, fallbackReason: "agent_not_accessible" };
  }

  // Step 4: 校验 task
  // 字面量 "default" (= config.sessionInit.defaultTaskId) 是虚拟值, 内核不存在
  // 该 task, listTasks/listTeams 返回里也不会有这条真实条目 (但 fetchTeamsAndAgents
  // 会在源头 unshift 一条 isDefault:true 的虚拟项, 所以 team.tasks[] 里能 find 到
  // id="default" 的 isDefault 项)。为了语义清晰, 这里显式短路: task === defaultTaskId
  // 直接通过, 不走 find。
  const defaultSentinel = input.defaultTaskId;
  const taskIsDefault = defaultSentinel !== undefined && def.task_id === defaultSentinel;
  if (!taskIsDefault) {
    const task = team.tasks.find((t) => t.task_id === def.task_id);
    if (!task) {
      console.warn(
        `${TAG} session=${input.compositeKey} user=${input.userId} fallback_reason=task_not_accessible team_id=${def.team_id} task_id=${def.task_id}`,
      );
      return { resolution: null, fallbackReason: "task_not_accessible" };
    }
  }

  console.log(
    `${TAG} session=${input.compositeKey} user=${input.userId} applied team=${def.team_id} agent=${def.agent_id} task=${def.task_id}`,
  );
  return {
    resolution: {
      teamId: def.team_id,
      agentId: def.agent_id,
      taskId: def.task_id,
      canRegister: true,
      hadMismatch: false,
      // 供调用方把命中 agent 补进 cachedTeams (下游 findTeamIdForAgent 用)。
      // 见 PresetResolution.agentName 注释。
      agentName: agent?.name,
    },
    fallbackReason: "",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Default-binding user-facing notice
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 命中账户默认时, 为用户构造一段**由 Proxy 直接下发**的绑定提示文本。
 *
 * ⚠️ 为什么由 Proxy 下发而不是让 LLM 转述:
 *   曾经两次尝试在 system prompt 里塞 [Notice] 块让 LLM "原样照抄":
 *     - 单行形式: LLM 把 agt-907zezo9y7 截断为 7zezo9y7, id 对不上
 *     - 多行行号形式: LLM 直接忽略整段指令, 一句话也不念
 *   根因是模型对事实性数据有自己的"编造 / 润色 / 省略"倾向, 且
 *   session_context 里竞争指令多 ([Agent] prompt / skill_tools / profile_memory
 *   等), [Notice] 的权重被稀释。
 *   因此改由 runner 层在 SSE 流最前面**直接拼一段 content delta**,
 *   和 LLM 回复独立、保证 100% 到达用户。
 *
 * 格式(与截图/用户诉求对齐):
 *   ✅ 当前 session 绑定默认配置：
 *
 *   - Team: <teamName> (<teamId>)
 *   - Agent: <agentName> (<agentId>)
 *   - Task: <taskName> (<taskId>)
 *
 * 虚拟 default task 时 Task 行只显示 "default" 占位(无 id)。
 *
 * @returns 格式化好的 markdown 文本; 不适用此场景时返 null (调用方据此跳过)。
 */
export function buildDefaultBindingNoticeIfApplicable(
  effectivePresetSource: string | undefined,
  teamName: string | null | undefined,
  teamId: string | null | undefined,
  agent: AgentDetail | null | undefined,
  task: TaskDetail | null | undefined,
  taskIdFromRegData: string | null | undefined,
): string | null {
  // 仅 user_default 场景出 Notice; header / form 场景用户已显式选过, 不打扰。
  if (effectivePresetSource !== "user_default") return null;

  const teamPart = teamName
    ? teamId
      ? `${teamName} (${teamId})`
      : teamName
    : teamId || "未知 Team";
  const agentPart = agent?.name
    ? agent.id
      ? `${agent.name} (${agent.id})`
      : agent.name
    : agent?.id || "未知 Agent";
  // 虚拟 default: taskIdFromRegData === "default" (哨兵值), task 为 null, 没有 id
  // 可展示。此时显式说明"不绑定任何 Task", 对齐 `mem:config-lock` 回显
  // (config-lock.ts `formatTriple` 对虚拟 default 的渲染) 以及面板的展示文案。
  const taskPart = task?.name
    ? `${task.name} (${task.id})`
    : taskIdFromRegData === "default"
      ? "default（不绑定任何 Task）"
      : (taskIdFromRegData || "default");

  return [
    "✅ 当前 session 绑定默认配置：",
    "",
    `- Team: ${teamPart}`,
    `- Agent: ${agentPart}`,
    `- Task: ${taskPart}`,
  ].join("\n");
}
