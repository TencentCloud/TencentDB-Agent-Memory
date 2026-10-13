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

import type { TeamOption } from "./types.js";
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

export async function resolveUserSessionDefault(
  input: ResolveUserSessionDefaultInput,
): Promise<PresetResolution | null> {
  if (!input.userId) return null;

  // Step 1: 读 Core
  let def;
  try {
    def = await input.metadataClient.getUserSessionDefault(input.userId);
  } catch (err) {
    console.warn(
      `${TAG} session=${input.compositeKey} user=${input.userId} get failed, fallback: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
  if (!def) {
    // 未设置默认, 走原流程。不打 log (正常路径, 避免噪音)。
    return null;
  }

  // Step 2: 校验 team 在当前 teams[] 里 (listTeams 已经隐式帮我们过滤了"user
  // 是否 team 成员")
  const team = input.teams.find((t) => t.team_id === def.team_id);
  if (!team) {
    console.warn(
      `${TAG} session=${input.compositeKey} user=${input.userId} fallback_reason=team_not_accessible team_id=${def.team_id}`,
    );
    return null;
  }

  // Step 3: 校验 agent 在该 team 的 agents 列表里
  const agent = team.agents.find((a) => a.agent_id === def.agent_id);
  if (!agent) {
    console.warn(
      `${TAG} session=${input.compositeKey} user=${input.userId} fallback_reason=agent_not_accessible team_id=${def.team_id} agent_id=${def.agent_id}`,
    );
    return null;
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
      return null;
    }
  }

  console.log(
    `${TAG} session=${input.compositeKey} user=${input.userId} applied team=${def.team_id} agent=${def.agent_id} task=${def.task_id}`,
  );
  return {
    teamId: def.team_id,
    agentId: def.agent_id,
    taskId: def.task_id,
    canRegister: true,
    hadMismatch: false,
  };
}
