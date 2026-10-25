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
  /** 工作区维度（''=全局默认）。 */
  workspaceId?: string;
  /** 当前会话 ID（sessionKey）——v3.5 会话级绑定（session:<id>）查找用。 */
  sessionKey?: string;
  /** v3.6：客户端品牌（agentSource）——待命绑定（arm:<brand>:<expiryTs>）匹配用。 */
  agentSource?: string;
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

  // v3.5：会话级绑定优先 —— 以 "session:<sessionKey>" 作为 workspace 维度复用
  // user-session-default 存储（meta_user_session_defaults 复合主键 user_id+workspace_id）。
  // 命中即返回；未命中回退 workspace/账户默认。优先级链：
  //   已初始化会话 > 会话级绑定 > workspace 绑定/账户默认 > header preset > 表单
  // v3.6：待命绑定（arm）优先 —— 用户在面板点「绑定下一个新会话」后落一条
  // workspace_id = arm:<brand>:<expiryTs> 的记录；这里在该用户新会话的首个请求
  // 到达时消费：转正为 session:<sessionKey> 绑定并直接应用。
  if (input.sessionKey && input.agentSource) {
    try {
      const rows = await input.metadataClient.listUserSessionDefaults(input.userId);
      const now = Date.now();
      for (const row of rows) {
        if (!row.workspace_id.startsWith('arm:' + input.agentSource + ':')) continue;
        const expiry = Number(row.workspace_id.split(':')[2]);
        if (!Number.isFinite(expiry) || expiry < now) {
          await input.metadataClient.deleteUserSessionDefault(input.userId, row.workspace_id); // 过期/损坏：只删不绑
          continue;
        }
        // P1-1：先转正后删除 —— set 失败时保留 arm 行，可被下一个新会话重试消费，不丢绑定
        await input.metadataClient.setUserSessionDefault(
          input.userId,
          { team_id: row.team_id, agent_id: row.agent_id, task_id: row.task_id, workspace_id: 'session:' + input.sessionKey },
        );
        const armed = await resolveForWorkspace(input, 'session:' + input.sessionKey, 'arm-binding');
        if (armed) {
          // 转正成功后才删 arm 行；删除失败仅残留一条无害的过期待命行（幂等：重复 set 同键为覆盖）
          try {
            await input.metadataClient.deleteUserSessionDefault(input.userId, row.workspace_id);
          } catch (delErr) {
            console.warn(TAG + ' arm-row cleanup failed (non-fatal): ' + (delErr instanceof Error ? delErr.message : String(delErr)));
          }
          console.log(
            TAG + ' session=' + input.compositeKey + ' user=' + input.userId
            + ' armed-binding consumed ws=' + row.workspace_id + ' -> session:' + input.sessionKey
          );
          return armed; // P1-3：绑定成功即终止，防止同品牌多条 arm 被循环覆盖
        }
        // P2-3：转正后懒校验失败（如 agent 已删）—— 清理本次转正行并消费掉该 arm 行，显式告警
        try { await input.metadataClient.deleteUserSessionDefault(input.userId, 'session:' + input.sessionKey); } catch { /* noop */ }
        try { await input.metadataClient.deleteUserSessionDefault(input.userId, row.workspace_id); } catch { /* noop */ }
        console.error(TAG + ' session=' + input.compositeKey + ' user=' + input.userId
          + ' arm-binding validation failed, consumed ws=' + row.workspace_id + '（请检查目标 agent 是否已被删除）');
      }
    } catch (err) {
      console.warn(TAG + ' arm-consume failed (non-fatal): ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  if (input.sessionKey) {
    const sessionBound = await resolveForWorkspace(input, 'session:' + input.sessionKey, 'session-binding');
    if (sessionBound) return sessionBound;
  }
  return resolveForWorkspace(input, input.workspaceId ?? '', 'user-default');
}

/** 按 workspace 维度解析一条绑定（含读时懒校验，失败返 null 不抛错）。 */
async function resolveForWorkspace(
  input: ResolveUserSessionDefaultInput,
  wsId: string,
  mode: string,
): Promise<PresetResolution | null> {
  // Step 1: 读 Core
  let def;
  try {
    def = await input.metadataClient.getUserSessionDefault(input.userId!, wsId);
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
    `${TAG} session=${input.compositeKey} user=${input.userId} applied mode=${mode} ws=${wsId} team=${def.team_id} agent=${def.agent_id} task=${def.task_id}`,
  );
  return {
    teamId: def.team_id,
    agentId: def.agent_id,
    taskId: def.task_id,
    canRegister: true,
    hadMismatch: false,
  };
}
