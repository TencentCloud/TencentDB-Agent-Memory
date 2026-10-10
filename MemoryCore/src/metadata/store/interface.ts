/**
 * IMetadataStore — 元数据存储抽象接口。
 *
 * 对应设计文档 §6.1。所有后端实现（SQLite / MongoDB / MySQL 预留）必须满足此契约，
 * 由 metadata-store.contract.ts 中的共用测试套件统一验证，保证后端行为一致。
 *
 * 约定：
 *   - 所有方法可同步或异步，调用方一律 await。
 *   - 复合写入（createTeam + 自动 admin、createTask + linkAgents、setAgentFixedAssets 全量替换）
 *     必须在实现内部保证原子性（SQLite 串行事务 / MongoDB withTransaction）。
 *   - get* 找不到返回 null；delete* 返回 BatchDeleteResult。
 */

import type {
  UserEntity,
  UserKeyEntity,
  TeamEntity,
  TeamMemberEntity,
  TeamMemberView,
  AgentEntity,
  TaskEntity,
  TaskAgentEntity,
  ParticipationLogEntity,
  AppendParticipationLogInput,
  ParticipationLogFilter,
  AssetEntity,
  FixedAssetBindingEntity,
  AgentFixedAssetCountRow,
  AclEntity,
  CreateUserInput,
  CreateUserKeyInput,
  CreateTeamInput,
  AddTeamMemberInput,
  CreateAgentInput,
  CreateTaskInput,
  CreateAssetInput,
  FixedAssetBindingInput,
  GrantAclInput,
  AgentFilter,
  TaskFilter,
  TeamFilter,
  AssetFilter,
  BatchDeleteResult,
  ListPage,
  PaginationParams,
  InstanceUserListFilter,
  TeamRole,
  ConfigParamEntity,
  UpsertConfigParamInput,
  ListConfigParamsFilter,
  InstanceUpstreamConfigEntity,
  InstanceUpstreamConfigFilter,
  CreateInstanceUpstreamGroupInput,
  UpdateInstanceUpstreamGroupInput,
  ToggleInstanceUpstreamGroupInput,
  DeleteInstanceUpstreamGroupInput,
  SupportedAgent,
} from "../types.js";

export type MaybePromise<T> = T | Promise<T>;

/**
 * 调用方指定 default_key_value / key_value 时，命中 meta_user_keys.key_value UNIQUE 约束。
 * Service 层 catch 后翻译为 MetadataError("duplicate_user_key")；HTTP 层映射为 409。
 * Store 层直接抛此错，独立于业务层 MetadataError（避免存储层反向依赖 service）。
 */
export class DuplicateUserKeyError extends Error {
  constructor(public readonly keyValue: string) {
    super(`user_key already exists: ${keyValue}`);
    this.name = "DuplicateUserKeyError";
  }
}

export interface IMetadataStore {
  /** 初始化存储（建表/建索引/建连接）。幂等。 */
  init(): MaybePromise<void>;
  /** 关闭存储连接。 */
  close(): MaybePromise<void>;

  // ── User ──
  createUser(input: CreateUserInput): MaybePromise<UserEntity>;
  getUserById(userId: string): MaybePromise<UserEntity | null>;
  getUserByKey(userKey: string): MaybePromise<UserEntity | null>;
  getUserByEmail(email: string): MaybePromise<UserEntity | null>;
  getUserByExternalId(authProvider: string, externalId: string): MaybePromise<UserEntity | null>;
  getUserByUsername(authProvider: string, username: string): MaybePromise<UserEntity | null>;
  updateUser(userId: string, patch: Partial<UserEntity>): MaybePromise<UserEntity | null>;
  deleteUsers(userIds: string[]): MaybePromise<BatchDeleteResult>;
  listUsersByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): MaybePromise<ListPage<UserEntity>>;
  listUsers(
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): MaybePromise<ListPage<UserEntity>>;
  countUsers(): MaybePromise<number>;
  countSystemAdmins(): MaybePromise<number>;
  countTeams(): MaybePromise<number>;

  // ── UserKey（多 API 密钥）──
  createUserKey(input: CreateUserKeyInput): MaybePromise<UserKeyEntity>;
  getUserKeyById(keyId: string): MaybePromise<UserKeyEntity | null>;
  listUserKeys(userId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<UserKeyEntity>>;
  countActiveUserKeys(userId: string): MaybePromise<number>;
  revokeUserKey(keyId: string, options?: { promoteNextDefault?: boolean }): MaybePromise<UserKeyEntity | null>;
  updateUserKey(keyId: string, patch: Partial<Pick<UserKeyEntity, "name" | "expires_at" | "is_default" | "metadata_json">>): MaybePromise<UserKeyEntity | null>;
  touchUserKeyUsage(keyId: string): MaybePromise<void>;
  revokeAllUserKeysForUser(userId: string): MaybePromise<void>;
  getDefaultUserKey(userId: string): MaybePromise<UserKeyEntity | null>;

  // ── Team ──（createTeam 自动把 owner 加为 admin 成员）
  createTeam(input: CreateTeamInput): MaybePromise<TeamEntity>;
  getTeamById(teamId: string): MaybePromise<TeamEntity | null>;
  updateTeam(teamId: string, patch: Partial<TeamEntity>): MaybePromise<TeamEntity | null>;
  deleteTeams(teamIds: string[]): MaybePromise<BatchDeleteResult>;
  listTeamsByUser(userId: string, pagination?: PaginationParams | null, filter?: TeamFilter): MaybePromise<ListPage<TeamEntity>>;

  // ── TeamMember ──
  addTeamMember(input: AddTeamMemberInput): MaybePromise<TeamMemberEntity>;
  removeTeamMember(teamId: string, userId: string): MaybePromise<void>;
  listTeamMembers(teamId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<TeamMemberEntity>>;
  getTeamMember(teamId: string, userId: string): MaybePromise<TeamMemberEntity | null>;
  listTeamMembersWithProfile(
    teamId: string,
    pagination?: PaginationParams | null,
  ): MaybePromise<ListPage<TeamMemberView>>;
  getTeamMemberWithProfile(teamId: string, userId: string): MaybePromise<TeamMemberView | null>;

  // ── Agent ──
  createAgent(input: CreateAgentInput): MaybePromise<AgentEntity>;
  getAgentById(agentId: string): MaybePromise<AgentEntity | null>;
  updateAgent(agentId: string, patch: Partial<AgentEntity>): MaybePromise<AgentEntity | null>;
  deleteAgents(agentIds: string[]): MaybePromise<BatchDeleteResult>;
  listAgentsByTeam(teamId: string, pagination?: PaginationParams | null, filter?: AgentFilter): MaybePromise<ListPage<AgentEntity>>;
  listAgentsByOwner(userId: string, pagination?: PaginationParams | null, filter?: AgentFilter): MaybePromise<ListPage<AgentEntity>>;

  // ── Task ──（createTask 可同时 linkAgents）
  createTask(input: CreateTaskInput): MaybePromise<TaskEntity>;
  getTaskById(taskId: string): MaybePromise<TaskEntity | null>;
  updateTask(taskId: string, patch: Partial<TaskEntity>): MaybePromise<TaskEntity | null>;
  deleteTasks(taskIds: string[]): MaybePromise<BatchDeleteResult>;
  listTasksByTeam(teamId: string, pagination?: PaginationParams | null, filter?: TaskFilter): MaybePromise<ListPage<TaskEntity>>;
  listTasks(filter: TaskFilter, pagination?: PaginationParams | null): MaybePromise<ListPage<TaskEntity>>;

  // ── TaskAgent ──
  linkTaskAgent(taskId: string, agentId: string, roleInTask?: string): MaybePromise<TaskAgentEntity>;
  unlinkTaskAgent(taskId: string, agentId: string): MaybePromise<void>;
  listTaskAgents(taskId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<TaskAgentEntity>>;

  // ── ParticipationLog ──
  appendParticipationLog(input: AppendParticipationLogInput): MaybePromise<ParticipationLogEntity>;
  listParticipationLogs(
    filter: ParticipationLogFilter,
    pagination?: PaginationParams | null,
  ): MaybePromise<ListPage<ParticipationLogEntity>>;

  // ── Asset ──（仅主表；详情表留在 control 面板）
  createAsset(input: CreateAssetInput): MaybePromise<AssetEntity>;
  getAssetById(assetId: string): MaybePromise<AssetEntity | null>;
  updateAsset(assetId: string, patch: Partial<AssetEntity>): MaybePromise<AssetEntity | null>;
  deleteAssets(assetIds: string[]): MaybePromise<BatchDeleteResult>;
  listAssetsByTeam(teamId: string, pagination?: PaginationParams | null, filter?: AssetFilter): MaybePromise<ListPage<AssetEntity>>;
  touchAssetUsage(assetId: string): MaybePromise<void>;

  // ── AgentFixedAsset ──（setAgentFixedAssets 全量替换）
  setAgentFixedAssets(agentId: string, bindings: FixedAssetBindingInput[]): MaybePromise<void>;
  /**
   * 追加一条 agent 绑定，**保留**该 agent 已有的其他绑定；(agent_id, asset_id)
   * 已存在时视作 no-op（幂等）。
   *
   * 场景：写入 memory 时自动登记 chat_memory 资产并绑定到 agent，且必须与
   * skill / wiki / code_graph 等其他资产的现有绑定共存 —— setAgentFixedAssets
   * 是全量替换会覆盖那些绑定，因此需要一个 append 语义的操作。
   */
  addAgentFixedAsset(agentId: string, binding: FixedAssetBindingInput): MaybePromise<void>;
  listAgentFixedAssets(
    agentId: string,
    pagination?: PaginationParams | null,
    /**
     * 可选过滤：仅返回 asset 类型在列表中的绑定。空/省略 = 不过滤。
     * store 内部 JOIN meta_assets 做 SQL 层过滤，避免"分页在前、类型过滤在后"截断。
     */
    filter?: { assetTypes?: readonly string[] },
  ): MaybePromise<ListPage<FixedAssetBindingEntity>>;
  getAgentFixedAsset(agentId: string, assetId: string): MaybePromise<FixedAssetBindingEntity | null>;
  /**
   * 按 agent_id + asset_type 聚合 COUNT(DISTINCT asset_id)。
   * 不补全缺失 agent / 缺失 type（由 Service 层补零）。
   */
  summarizeAgentFixedAssetsByAgents(
    agentIds: string[],
    options?: { assetId?: string },
  ): MaybePromise<AgentFixedAssetCountRow[]>;

  // ── ACL ──
  grantAcl(input: GrantAclInput): MaybePromise<AclEntity>;
  getAclById(id: string): MaybePromise<AclEntity | null>;
  revokeAcl(id: string): MaybePromise<void>;
  listAclByAsset(assetId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<AclEntity>>;
  listAclBySubject(subjectType: string, subjectId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<AclEntity>>;

  // ── ConfigParam ──
  getConfigParam(
    scope: "global" | "user",
    userId: string | null,
    module: string,
    paramName: string,
  ): MaybePromise<ConfigParamEntity | null>;
  upsertConfigParam(input: UpsertConfigParamInput): MaybePromise<ConfigParamEntity>;
  listConfigParams(filter: ListConfigParamsFilter): MaybePromise<ConfigParamEntity[]>;

  // ── InstanceUpstreamConfig (v2 模型组) ──
  //
  // 语义详见 docs/design/2026-08-25-instance-upstream-config.md §5 / §6。
  // 关键约束(store 层必须保证):
  //   1. group_id 由 store 生成 (dflt-<r> / grp-<r> / ext-<r>)。
  //   2. default / extraction 每实例最多 1 行(UNIQUE partial index)。
  //   3. agents 全域唯一:同一实例内 default.agents ∪ 所有 custom.agents 元素两两不重复。
  //      写入时需在事务内 SELECT-all → 内存交集校验 → 写入,冲突抛
  //      InstanceUpstreamWriteConflictError("agents_overlap")。
  //   4. version 字段乐观锁:update / toggle 传入 expected_version,不匹配抛
  //      InstanceUpstreamWriteConflictError("version_mismatch")。SQLite 侧
  //      同时用 BEGIN IMMEDIATE 加事务锁,双重保护。
  //   5. seed 幂等:listGroups 见空表触发 ensureDefaultSeeded;两个并发写入
  //      靠 default 单例 UNIQUE 约束兜底。

  /** 按 group_id 精确获取一行(不存在返 null)。 */
  getInstanceUpstreamGroup(groupId: string): MaybePromise<InstanceUpstreamConfigEntity | null>;

  /**
   * 列出该实例的所有行(default + custom + extraction),按 group_type 排序
   * (default 首、custom 次、extraction 末),同类按 updated_at DESC。
   * 触发 ensureDefaultSeeded:如果表内 0 default 行且传入 supported-agents
   * 非空,自动 seed 一条 default 行(agents=supportedAgents, enabled=true)。
   * 传 undefined 时不触发 seed。
   */
  listInstanceUpstreamGroups(
    filter?: InstanceUpstreamConfigFilter,
    seedIfEmpty?: SupportedAgent[],
  ): MaybePromise<InstanceUpstreamConfigEntity[]>;

  /**
   * 创建新组:custom / default(仅 seed 内部用) / extraction。
   * 冲突场景:
   *   - default_already_exists / extraction_already_exists → 抛 InstanceUpstreamWriteConflictError
   *   - agents 与其他行重叠 → agents_overlap
   */
  createInstanceUpstreamGroup(
    input: CreateInstanceUpstreamGroupInput,
  ): MaybePromise<InstanceUpstreamConfigEntity>;

  /**
   * PATCH 更新已存在的组;冲突场景:
   *   - group_not_found / group_type_mismatch / version_mismatch / agents_overlap
   */
  updateInstanceUpstreamGroup(
    input: UpdateInstanceUpstreamGroupInput,
  ): MaybePromise<InstanceUpstreamConfigEntity>;

  /** toggle enabled 快捷接口(是 update 的语法糖,同样支持 expected_version)。 */
  toggleInstanceUpstreamGroup(
    input: ToggleInstanceUpstreamGroupInput,
  ): MaybePromise<InstanceUpstreamConfigEntity>;

  /** 物理删除,不存在返 false。 */
  deleteInstanceUpstreamGroup(
    input: DeleteInstanceUpstreamGroupInput,
  ): MaybePromise<boolean>;

  /**
   * 幂等确保 default 行存在。给存量实例首次直接调 create/update/toggle/delete
   * 等写入接口时兜底 seed —— 只走过 list 的实例会自动 seed,但 Panel 也可能不经
   * list 直接进入 "新建 custom" 或 extraction 流程,那种情况下若不 seed,后续
   * 请求会撞 AGENT_NOT_CONFIGURED。
   *
   * 语义:
   *   - supported 为空 → no-op(尊重 list 侧 "undefined 不 seed" 的约定)
   *   - 表内已存在 default → no-op
   *   - 无 default → INSERT 一行(agents=supported、mode=official、enabled=true、
   *     snapshot=supported),与 list 侧 seed 分支完全一致
   *   - 并发 seed → 依赖 default 行的 UNIQUE partial index 兜底
   *
   * 不做 diff-append(方案 E 的收敛只在 list 时跑,避免所有写入路径都刷 snapshot)。
   */
  ensureDefaultSeeded(supported: SupportedAgent[]): MaybePromise<void>;
}

/** 后端类型。 */
export type MetadataBackend = "sqlite" | "mongodb" | "mysql";

export type { TeamRole };
