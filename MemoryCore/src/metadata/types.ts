/**
 * Metadata module — Entity types & shared contracts.
 *
 * 对应设计文档 08-metadata-migration-and-permission-design.md §2 / §6。
 *
 * 这是从 team-memory-control 搬迁到记忆内核的元数据实体类型定义。
 * 与 core/store 中已有的简化 entity_* 类型不同，这里是完整的业务模型
 * （含 user_key / password / visibility / acl 等）。
 */

// ============================
// 枚举与字面量类型
// ============================

export type UserStatus = "active" | "inactive" | "invited";
export type UserType = "normal" | "system_admin";
export type TeamStatus = "active" | "archived";
export type TeamRole = "admin" | "member" | "reviewer";
export type MemberStatus = "active" | "removed";
export type AgentStatus = "active" | "inactive";
export type TaskStatus = "running" | "completed";
/**
 * Task 来源的**大类**，不编码具体来源系统。
 *
 * - `manual`：用户在看板手工新建。
 * - `external`：从第三方需求/任务系统导入。具体是哪个系统
 *   （tapd / jira / …）一律读 `metadata_json.external.provider`。
 * - `other`：其它。
 *
 * 刻意**不**把每个来源做成枚举项：那会让新增来源变成「改类型定义 + 改所有
 * 引用处」的散弹式改动。来源标识是开放集合，放在 metadata 里才可扩展。
 */
export type TaskSourceType = "manual" | "external" | "other";

export type AssetType = "skill" | "llm_wiki" | "code_graph" | "chat_memory";
export type AssetVisibility = "private" | "team" | "restricted" | "agent" | "task";
export type AssetStatus =
  | "draft"
  | "candidate"
  | "approved"
  | "deprecated"
  | "archived"
  | "failed";

export type InjectionMode = "direct" | "summary" | "tool" | "reference";

/** 权限动作（6 类）。 */
export type Permission =
  | "read"
  | "write"
  | "delete"
  | "assign"
  | "share"
  | "use";

/** ACL 授权主体类型。 */
export type AclSubjectType = "user" | "team_role" | "agent";

/** ACL 效果（一期仅 allow，deny 预留）。 */
export type AclEffect = "allow" | "deny";

// ============================
// 实体类型
// ============================

export type UserKeyStatus = "active" | "revoked";

export interface UserEntity {
  user_id: string;
  /** scrypt+pepper 哈希后的密码（`$scrypt$...`），可空。 */
  password?: string | null;
  auth_provider: string;
  external_id: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  raw_profile_json: string;
  status: UserStatus;
  user_type: UserType;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TeamEntity {
  team_id: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  status: TeamStatus;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TeamMemberEntity {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamRole;
  joined_at: string;
  status: MemberStatus;
}

/** team-member/list · get 响应：成员关系 + 读时 JOIN 的 username（不落库）。 */
export interface TeamMemberView extends TeamMemberEntity {
  username: string;
}

export interface AgentEntity {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility: AssetVisibility;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TaskEntity {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string | null;
  source_type: TaskSourceType;
  source_url?: string | null;
  status: TaskStatus;
  auto_assign_floating_assets: boolean;
  risk_level?: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TaskAgentEntity {
  id: string;
  task_id: string;
  agent_id: string;
  role_in_task?: string | null;
  status: MemberStatus;
  created_at: string;
}

/** Task/Agent 参与事件日志（append-only）。 */
export interface ParticipationLogEntity {
  id: string;
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  source: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface AppendParticipationLogInput {
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  created_at?: string;
  source?: string;
  metadata_json?: string;
}

export interface ParticipationLogFilter {
  team_id: string;
  task_id?: string;
  agent_id?: string;
  user_id?: string;
  created_after?: string;
  created_before?: string;
  /** 是否按 user_id 去重；默认 false。 */
  dedupe?: boolean;
}

export interface AssetEntity {
  asset_id: string;
  team_id: string;
  asset_type: AssetType;
  name: string;
  description?: string | null;
  owner_user_id: string;
  source_type: string;
  source_ref?: string | null;
  version: number;
  visibility: AssetVisibility;
  status: AssetStatus;
  confidence?: number | null;
  expires_at?: string | null;
  last_used_at?: string | null;
  usage_count: number;
  content_ref?: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface FixedAssetBindingEntity {
  id: string;
  agent_id: string;
  asset_id: string;
  asset_type: AssetType;
  injection_mode: InjectionMode;
  priority: number;
  created_by: string;
  created_at: string;
}

/** 按 asset_type 聚合的固定资产绑定计数（distinct asset_id）。 */
export interface FixedAssetTypeCounts {
  skill: number;
  code_graph: number;
  llm_wiki: number;
  chat_memory: number;
}

/** 单个 agent 的固定资产分配汇总。 */
export interface AgentFixedAssetSummary {
  agent_id: string;
  counts: FixedAssetTypeCounts;
  /** 该 agent 匹配到的 binding 总行数（非去重）。 */
  total: number;
}

/** summary-by-agents 响应。 */
export interface AgentFixedAssetSummaryResult {
  items: AgentFixedAssetSummary[];
  total: number;
}

/** Store/Service：按多 agent 分组统计固定资产绑定。 */
export interface SummarizeAgentFixedAssetsParams {
  agent_ids: string[];
  /** 可选：只统计绑定了该 asset 的行；用于 bound_agent_count。 */
  asset_id?: string;
}

/** Store 层原始聚合行（未补零）。 */
export interface AgentFixedAssetCountRow {
  agent_id: string;
  asset_type: AssetType;
  cnt: number;
}

/** 用户 API 密钥行（存储层，含完整 key_value）。 */
export interface UserKeyEntity {
  key_id: string;
  user_id: string;
  key_value: string;
  name?: string | null;
  status: UserKeyStatus;
  is_default: boolean;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
  metadata_json: string;
}

/** API 脱敏结构（list / get）。 */
export interface UserKeyPublic {
  key_id: string;
  user_id: string;
  key_prefix: string;
  name?: string | null;
  status: UserKeyStatus;
  is_default: boolean;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
}

/** create 响应：仅此一次返回完整 key_value。 */
export interface UserKeyCreated extends UserKeyPublic {
  key_value: string;
}

export interface AclEntity {
  id: string;
  asset_id: string;
  subject_type: AclSubjectType;
  subject_id: string;
  permission: Permission;
  effect: AclEffect;
  granted_by: string;
  created_at: string;
  updated_at: string;
}

// ============================
// 输入类型（创建/更新）
// ============================

export interface UserPublic {
  user_id: string;
  user_type: UserType;
  username: string;
  created_at: string;
}

/** 公开 user/list 可选过滤（internal list-by-instance 另含 status / user_type）。 */
export interface UserListFilter {
  user_ids?: string[];
  /** 精确匹配用户名（用于查重等场景）。 */
  username?: string;
}

/** user/create 响应：不含 username（见 08 §CreateUserResult）。 */
export interface CreateUserApiResult {
  user_id: string;
  user_type: UserType;
  created_at: string;
  default_user_key: string;
}

export interface InitAdminInput {
  username: string;
  user_key?: string;
}

export interface InitAdminResult {
  user_id: string;
  user_key: string;
}

export interface CreateUserInput {
  user_id?: string;
  /** 内部：init-admin 可指定默认 user_key。 */
  default_key_value?: string;
  /** 存储层默认 `local`（API 不暴露）。 */
  auth_provider?: string;
  /** 存储层默认 `user_id`（API 不暴露）。 */
  external_id?: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  raw_profile_json?: string;
  status?: UserStatus;
  metadata_json?: string;
  /** 仅存储层内部使用；API create 固定 normal，init-admin 固定 system_admin。 */
  user_type?: UserType;
  /** v3.1：新用户恒 NULL；仅 store 层写入。 */
  password?: string | null;
}

export interface CreateUserKeyInput {
  user_id: string;
  key_value?: string;
  name?: string | null;
  expires_at?: string | null;
  is_default?: boolean;
  metadata_json?: string;
}

export interface CreateTeamInput {
  team_id?: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  status?: TeamStatus;
  metadata_json?: string;
}

export interface AddTeamMemberInput {
  id?: string;
  team_id: string;
  user_id: string;
  role?: TeamRole;
  status?: MemberStatus;
}

export interface CreateAgentInput {
  agent_id?: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility?: AssetVisibility;
  status?: AgentStatus;
  metadata_json?: string;
}

export interface CreateTaskInput {
  task_id?: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string | null;
  source_type?: TaskSourceType;
  source_url?: string | null;
  status?: TaskStatus;
  auto_assign_floating_assets?: boolean;
  risk_level?: string | null;
  metadata_json?: string;
  /** 创建 task 时可同时关联的 agent。 */
  linked_agents?: Array<{ agent_id: string; role_in_task?: string }>;
}

export interface CreateAssetInput {
  /** 由调用方（外部资产系统）提供，元数据模块仅记录与鉴权，不生成 asset_id。 */
  asset_id: string;
  team_id: string;
  asset_type: AssetType;
  name: string;
  description?: string | null;
  owner_user_id: string;
  source_type: string;
  source_ref?: string | null;
  visibility?: AssetVisibility;
  status?: AssetStatus;
  confidence?: number | null;
  expires_at?: string | null;
  content_ref?: string | null;
  metadata_json?: string;
}

export interface FixedAssetBindingInput {
  asset_id: string;
  asset_type: AssetType;
  injection_mode?: InjectionMode;
  priority?: number;
  created_by: string;
}

export interface GrantAclInput {
  id?: string;
  asset_id: string;
  subject_type: AclSubjectType;
  subject_id: string;
  permission: Permission;
  effect?: AclEffect;
  granted_by: string;
}

// ============================
// 过滤器类型
// ============================

export interface AgentFilter {
  status?: AgentStatus;
  /**
   * 组合过滤：与 team_id 一起使用时表示"团队内某用户 owner 的 agent"。
   * 单独使用 owner_user_id 时走 listAgentsByOwner，无需该字段。
   */
  owner_user_id?: string;
  /** 精确匹配 agent 名称（用于查重等场景）。 */
  name?: string;
}

export interface TaskFilter {
  status?: TaskStatus;
  creator_user_id?: string;
  /** 精确匹配 task 标题（用于查重等场景）。 */
  title?: string;
}

/** team/list 可选过滤（用于查重等场景）。 */
export interface TeamFilter {
  /** 精确匹配 team 名称。 */
  name?: string;
}

export interface AssetFilter {
  asset_type?: AssetType;
  status?: AssetStatus;
  owner_user_id?: string;
  visibility?: AssetVisibility;
}

// ============================
// 通用结果类型
// ============================

/** list 接口分页入参（可选；未传时服务端默认 limit=20、offset=0）。 */
export interface PaginationInput {
  limit?: number;
  offset?: number;
}

/** 解析后的分页参数（limit/offset 均有确定值）。 */
export interface PaginationParams {
  limit: number;
  offset: number;
}

/** list 接口分页响应信封。 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Store 层 list 查询结果（内部分页切片 + 总数）。 */
export interface ListPage<T> {
  items: T[];
  total: number;
}

/** internal list-by-instance 可选过滤（扩展 UserListFilter）。 */
export interface InstanceUserListFilter extends UserListFilter {
  status?: UserStatus;
  user_type?: UserType;
}

export interface BatchDeleteResult {
  deleted_ids: string[];
  failed: Array<{ id: string; reason: string }>;
}

// ============================
// ConfigParam 类型
// ============================

export type ConfigParamScope = "global" | "user";

export interface ConfigParamEntity {
  id: number;
  scope: ConfigParamScope;
  user_id: string | null;
  module: string;
  param_name: string;
  param_value: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertConfigParamInput {
  scope: ConfigParamScope;
  user_id?: string | null;
  module: string;
  param_name: string;
  param_value: string;
  description: string;
}

export interface ListConfigParamsFilter {
  scope?: ConfigParamScope;
  module: string;
  userId?: string;
  paramNames?: string[];
}

// ============================
// InstanceUpstreamConfig 类型（v2 模型组结构）
// ============================
//
// 对应设计文档 docs/design/2026-08-25-instance-upstream-config.md §5.1。
// v2 从"一行=一 agent"重构为"一行=一模型组"：
//   - default 组:每实例最多 1 行,mode=official,name 固定"官方内置"
//   - custom 组:0~N 行,mode ∈ {custom_unified, custom_passthrough},name 用户自定义
//   - extraction 行:0 或 1 行,mode=custom_unified,agents 恒 [],name 固定"抽取模型"
//
// 与 v1 的核心差异:
//   - agents 从"每行一个 agent_source"升级为"每行一个 agents 数组"
//   - 引入 group_id (前缀 ULID) + group_type + name + enabled 字段
//   - agents 全域唯一(default + custom 不重叠)
//   - MongoDB 版本乐观锁(version 字段)保护并发写

export type GroupType = "default" | "custom" | "extraction";
export type UpstreamMode = "official" | "custom_unified" | "custom_passthrough";

/** default 组 name 固定值（用户不可改）。 */
export const DEFAULT_GROUP_NAME = "官方内置";
/** extraction 行 name 固定值（用户不可改）。 */
export const EXTRACTION_GROUP_NAME = "抽取模型";

/**
 * 实例上游配置行（存储层实体）。
 *
 * 一行 = 一个模型组(default / custom / extraction)。
 * agents 字段以 JSON 数组形式存储(SQLite 用 TEXT 存 JSON, MongoDB 用原生数组)。
 * MongoDB 侧额外多一个 `version` 字段(乐观锁,§5.3);SQLite 不需要。
 */
export interface InstanceUpstreamConfigEntity {
  id: number;
  /** 后端生成的组 ID:`dflt-<random>` / `grp-<random>` / `ext-<random>`。 */
  group_id: string;
  group_type: GroupType;
  /** custom: 用户自定义;default 固定 DEFAULT_GROUP_NAME;extraction 固定 EXTRACTION_GROUP_NAME。 */
  name: string;
  /**
   * default / custom 组:显式管理的 agent 列表(可 0~N);extraction 行:恒 []。
   * 全域唯一约束:同一实例内 default.agents ∪ 所有 custom.agents 元素两两不重复。
   */
  agents: string[];
  /**
   * 三种 group_type 的 enabled 语义不同:
   *   - default:  false = 命中该组的 agent 请求报 UPSTREAM_DISABLED
   *   - custom:   false = 命中该组的 agent 请求报 UPSTREAM_DISABLED
   *   - extraction: false = 优雅回退到全局 upstream(不报错)
   */
  enabled: boolean;
  mode: UpstreamMode;
  base_url: string;
  api_key: string;
  model_id: string;
  description: string;
  created_at: string;
  updated_at: string;
  /** 乐观锁版本号。MongoDB 每次写入 $inc:1；SQLite 忽略此字段（依赖 BEGIN IMMEDIATE 事务）。 */
  version: number;
  /**
   * 仅 default 组有值:上次 listGroups 时看到的 supported-agents 全集快照(去重 + 排序)。
   *
   * 用于"Proxy 新增 agent 后自动补齐 default.agents"逻辑(见 store 层
   * `_syncDefaultAgentsWithSnapshot`):
   *   - Proxy 加了 cursor,supported-agents 从 [old8] 变 [old8+cursor]
   *   - listGroups 触发 diff:supported - snapshot = [cursor]
   *   - 自动 append 到 default.agents,同时更新 snapshot = [old8+cursor]
   *   - 用户主动 remove 的 agent(agents 里没,但 snapshot 里有)保留决策不变
   *
   * 存量实例首次 listGroups 时 snapshot=空 → 视为"用户已认可当前 agents",
   * 直接把 snapshot 填成 agents(不改 agents),后续新增才走 diff-append。
   *
   * custom / extraction 组恒为 [];不参与 diff。
   */
  supported_agents_snapshot: string[];
}

/**
 * create 输入:新建 default (seed 内部用) / custom / extraction 行。
 * group_id 由 store 层生成,调用方不传。
 */
export interface CreateInstanceUpstreamGroupInput {
  group_type: GroupType;
  name?: string;
  agents?: string[];
  enabled?: boolean;
  mode: UpstreamMode;
  base_url?: string;
  api_key?: string;
  model_id?: string;
  description?: string;
}

/**
 * update 输入:PATCH 语义,未传字段保留原值。
 * `api_key`:undefined = 保留原值;空串 = 显式清空。
 */
export interface UpdateInstanceUpstreamGroupInput {
  group_id: string;
  /** 期望的 group_type,用作 dispatch 守卫(与库中不符 → GROUP_TYPE_MISMATCH)。 */
  expected_group_type: GroupType;
  /** 乐观锁:调用方传当前读到的 version,写入时匹配失败 → WRITE_CONFLICT。 */
  expected_version?: number;
  name?: string;
  agents?: string[];
  enabled?: boolean;
  mode?: UpstreamMode;
  base_url?: string;
  api_key?: string;
  model_id?: string;
  description?: string;
}

/** toggle 单字段快捷接口输入(是 update 的语法糖)。 */
export interface ToggleInstanceUpstreamGroupInput {
  group_id: string;
  enabled: boolean;
  expected_version?: number;
}

/** delete 输入:按 group_id 物理删除。 */
export interface DeleteInstanceUpstreamGroupInput {
  group_id: string;
}

/** 查询过滤(list 用)。 */
export interface InstanceUpstreamConfigFilter {
  group_type?: GroupType;
}

/** supported-agents 单元(Core yaml 里读出来,也是本模块 seed default agents 的来源)。 */
export interface SupportedAgent {
  agent_source: string;
  protocol: "anthropic" | "openai-chat" | "openai-responses";
  display_name: string;
}

/**
 * 写入冲突:并发写入时 agents 重叠、group_id 缺失、version 不匹配等。
 * Store 层直接抛此错(不依赖 service 层的 MetadataError,避免反向依赖)。
 */
export class InstanceUpstreamWriteConflictError extends Error {
  constructor(
    public readonly reason: "agents_overlap" | "name_duplicate" | "group_not_found" | "group_type_mismatch" | "version_mismatch" | "default_already_exists" | "extraction_already_exists",
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InstanceUpstreamWriteConflictError";
  }
}
