/**
 * UserSessionDefaultService — "用户级 session 默认 (team, agent, task) 三元组"业务层。
 *
 * 对应设计文档: MemoryProxy/docs/design/2026-10-10-user-session-default-design.md §4。
 *
 * 职责:
 *   - set:  鉴权 (caller == user_id) → 交叉校验 team/agent/task 归属 + user 成员资格
 *           + agent 可见性 → upsert
 *   - get:  鉴权 → 读
 *   - delete: 鉴权 → 幂等删
 *
 * 关键决策:
 *   - task_id === DEFAULT_TASK_SENTINEL ("default") 是虚拟值, 内核不存在该 task,
 *     跳过 task 实体校验 (与 Proxy 侧 sessionInit.defaultTaskId 契约对称)。
 *   - 鉴权仅允许本人改本人; admin 不能代设 (PRD 第 1 条明确约束)。
 *   - 失败一律抛 MetadataError, Router 层将其翻译为统一 envelope error code。
 */

import type { IMetadataStore } from "../store/interface.js";
import type { MetadataService } from "./metadata-service.js";
import { MetadataError } from "./metadata-service.js";
import {
  DEFAULT_TASK_SENTINEL,
  type UserSessionDefaultEntity,
  type UpsertUserSessionDefaultInput,
} from "../types.js";

/** 面向 Router 的输入 (user_id 必传, task_id 必填, 可为 DEFAULT_TASK_SENTINEL)。 */
export interface SetUserSessionDefaultInput {
  user_id: string;
  team_id: string;
  agent_id: string;
  task_id: string;
}

export interface IUserSessionDefaultService {
  get(callerId: string, userId: string): Promise<UserSessionDefaultEntity | null>;
  set(callerId: string, input: SetUserSessionDefaultInput): Promise<UserSessionDefaultEntity>;
  delete(callerId: string, userId: string): Promise<{ ok: true }>;
}

export class UserSessionDefaultService implements IUserSessionDefaultService {
  constructor(
    private readonly store: IMetadataStore,
    private readonly metaService: MetadataService,
  ) {}

  async get(callerId: string, userId: string): Promise<UserSessionDefaultEntity | null> {
    this.metaService.assertCallerIsOwner(userId, callerId);
    return (await this.store.getUserSessionDefault(userId)) ?? null;
  }

  async set(callerId: string, input: SetUserSessionDefaultInput): Promise<UserSessionDefaultEntity> {
    this.metaService.assertCallerIsOwner(input.user_id, callerId);

    // PRD "后端要求": 记录设置 / 覆盖 / 解除日志。日志只含 ID, 不含任何 Token
    // 或凭证。面板保存路径(经 BFF)和 IDE 命令路径(mem:config-lock)都经过这里,
    // 因此这三处 log 同时覆盖两个入口。
    //
    // 先探测"是否已有旧配置"用于区分 create / overwrite, 但**成功日志要等 upsert
    // 之后再打** —— 否则校验失败(team 不存在 / agent 不可见 / task 已结束等)时也
    // 会留下一条 "set create/overwrite" 记录, 排查时会被误导成"已经写进去了"。
    const existed = await this.store.getUserSessionDefault(input.user_id);

    // 校验失败统一记 rejected (含具体 error code), 与"写库失败"区分。
    // 这样日志里 set 只有三种终态: create / overwrite / rejected。
    try {
      return await this.setValidated(input, existed);
    } catch (err) {
      const code = err instanceof MetadataError ? err.code : "write_failed";
      console.warn(
        `[user-session-default] set rejected user=${input.user_id} reason=${code} ` +
          `team=${input.team_id} agent=${input.agent_id} task=${input.task_id}`,
      );
      throw err;
    }
  }

  /** 实际的四级校验 + upsert。抽出来只为让外层能统一记 rejected 日志。 */
  private async setValidated(
    input: SetUserSessionDefaultInput,
    existed: UserSessionDefaultEntity | null,
  ): Promise<UserSessionDefaultEntity> {
    // 1. Team 必须存在
    const team = await this.store.getTeamById(input.team_id);
    if (!team) {
      throw new MetadataError(
        "entity_not_found",
        `team not found: ${input.team_id}`,
      );
    }

    // 2. User 必须是 Team 的活跃成员
    const member = await this.store.getTeamMember(input.team_id, input.user_id);
    if (!member || member.status !== "active") {
      throw new MetadataError(
        "user_not_in_team",
        `user ${input.user_id} is not an active member of team ${input.team_id}`,
      );
    }

    // 3. Agent 必须存在、属于该 team、active, 且对 user 可见
    const agent = await this.store.getAgentById(input.agent_id);
    if (!agent) {
      throw new MetadataError(
        "entity_not_found",
        `agent not found: ${input.agent_id}`,
      );
    }
    if (agent.team_id !== input.team_id) {
      throw new MetadataError(
        "agent_team_mismatch",
        `agent ${input.agent_id} does not belong to team ${input.team_id}`,
      );
    }
    if (agent.status !== "active") {
      throw new MetadataError(
        "agent_not_accessible",
        `agent ${input.agent_id} is not active`,
      );
    }
    // 可见性: owner==self 或 team 级可见。与 session-init 现有筛选
    // (metaClient.listAgents(team, owner=self)) 的"用户只看自己 agent"行为对齐,
    // 但同时允许 team-wide visible 的 agent (给 team 共享 agent 预留能力)。
    if (agent.owner_user_id !== input.user_id && agent.visibility !== "team") {
      throw new MetadataError(
        "agent_not_accessible",
        `agent ${input.agent_id} is not visible to user ${input.user_id}`,
      );
    }

    // 4. Task: 字面量 "default" 跳过, 其他必须属于 team 且 running
    if (input.task_id !== DEFAULT_TASK_SENTINEL) {
      const task = await this.store.getTaskById(input.task_id);
      if (!task) {
        throw new MetadataError(
          "entity_not_found",
          `task not found: ${input.task_id}`,
        );
      }
      if (task.team_id !== input.team_id) {
        throw new MetadataError(
          "task_team_mismatch",
          `task ${input.task_id} does not belong to team ${input.team_id}`,
        );
      }
      if (task.status !== "running") {
        throw new MetadataError(
          "task_inactive",
          `task ${input.task_id} is not running (status=${task.status})`,
        );
      }
    }

    // 5. upsert
    const payload: UpsertUserSessionDefaultInput = {
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
    };

    const saved = await this.store.upsertUserSessionDefault(payload);
    console.log(
      `[user-session-default] set user=${input.user_id} ` +
        `${existed ? "overwrite" : "create"} ` +
        `team=${input.team_id} agent=${input.agent_id} task=${input.task_id}`,
    );
    return saved;
  }

  async delete(callerId: string, userId: string): Promise<{ ok: true }> {
    this.metaService.assertCallerIsOwner(userId, callerId);
    // 幂等: 没有配置也返回 ok。日志区分"真的删掉了"与"本来就没有", 便于
    // 排查"用户反馈解除无效"类问题。
    const existed = await this.store.getUserSessionDefault(userId);
    console.log(
      `[user-session-default] delete user=${userId} ` +
        `${existed ? "removed" : "no-op (not set)"}`,
    );
    await this.store.deleteUserSessionDefault(userId);
    return { ok: true };
  }
}
