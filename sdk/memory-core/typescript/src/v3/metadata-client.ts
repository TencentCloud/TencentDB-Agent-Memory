/**
 * v3 MetadataClient — 封装 `/v3/meta/*` 公开管理面接口（与 Panel Control `META_ACTIONS` 对齐，54 条）。
 *
 * 另含 `/v3/knowledge/*` Knowledge 实体 CRUD（5 条，非 meta 前缀）。
 * 鉴权：Bearer + x-tdai-service-id + x-tdai-user-key（`auth/verify` 仅 body 传 user_key）。
 */

import { ParamError } from "../errors.js";
import { V3HttpTransport } from "./http.js";
import type { Transport } from "../client.js";
import type {
  UserPublic,
  CreateUserResult,
  UserKeyPublic,
  UserKeyCreated,
  CreateUserKeyRequest,
  ListUserKeysRequest,
  UpdateUserKeyRequest,
  TeamEntity,
  TeamMemberEntity,
  AgentEntity,
  TaskEntity,
  TaskAgentEntity,
  ParticipationLogEntity,
  AppendParticipationLogRequest,
  ListParticipationLogsRequest,
  AssetEntity,
  FixedAssetBindingEntity,
  AclEntity,
  BatchDeleteResult,
  AgentFixedAssetDetailResult,
  AgentFixedAssetSummaryResult,
  SummarizeAgentFixedAssetsRequest,
  PermCheckResult,
  AuthVerifyResult,
  InstanceQuotaLimits,
  UserConfigView,
  GetUserConfigRequest,
  SetUserConfigRequest,
  CreateUserRequest,
  ListUsersRequest,
  CreateTeamRequest,
  UpdateTeamRequest,
  AddTeamMemberRequest,
  CreateAgentRequest,
  UpdateAgentRequest,
  ListAgentsRequest,
  ListTeamsRequest,
  ListTasksRequest,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreateAssetRequest,
  UpdateAssetRequest,
  ListAssetsRequest,
  FixedAssetBindingInput,
  ListWithDetailRequest,
  GrantAclRequest,
  CheckAclRequest,
  ListAccessibleAssetsRequest,
  GetUserRequest,
  PaginationInput,
  PaginatedResult,
  // Knowledge (v3 管理面实体，/v3/knowledge/*)
  KnowledgeEntity,
  KnowledgeType,
  KnowledgeListResult,
  CreateKnowledgeRequest,
  UpdateKnowledgeRequest,
  ListKnowledgeRequest,
} from "./metadata-types.js";

const V3 = "/v3/meta";
/** Knowledge 实体管理面挂在 /v3/knowledge/*（extraRouteTable，不在 /v3/meta 前缀下）。 */
const V3_KNOWLEDGE = "/v3/knowledge";

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function body(o: object): Record<string, unknown> {
  if (!o || typeof o !== "object" || Array.isArray(o)) {
    throw new ParamError("request payload must be an object");
  }
  return stripUndefined(o as Record<string, unknown>);
}

function requireAnyString(
  payload: Record<string, unknown>,
  fields: string[],
  operation: string,
): void {
  if (!fields.some((field) => typeof payload[field] === "string" && (payload[field] as string).trim())) {
    throw new ParamError(`${operation} requires one of ${fields.join(", ")}`);
  }
}

export interface MetadataClientConfig {
  /** Base URL, e.g. `https://memory.tencentyun.com` */
  endpoint: string;
  /** 网关 Bearer 密钥（KERNEL_AUTH_TOKEN）。 */
  apiKey: string;
  /** 记忆实例 ID（x-tdai-service-id）。 */
  serviceId: string;
  /** 用户 API 密钥（x-tdai-user-key）；user/create、user/delete 须 system_admin key。 */
  userKey?: string;
  /** Request timeout in ms (default 30 000). */
  timeout?: number;
  /** Whether to reject invalid TLS certificates. Default: true. */
  rejectUnauthorized?: boolean;
}

export class MetadataClient {
  private readonly http: Transport;

  constructor(config: MetadataClientConfig);
  constructor(transport: Transport);
  constructor(configOrTransport: MetadataClientConfig | Transport) {
    if ("post" in configOrTransport) {
      this.http = configOrTransport;
    } else {
      const cfg = configOrTransport;
      if (!cfg.apiKey) throw new ParamError("apiKey must be provided");
      if (!cfg.serviceId) throw new ParamError("serviceId must be provided");
      this.http = new V3HttpTransport({
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey,
        serviceId: cfg.serviceId,
        userKey: cfg.userKey,
        timeout: cfg.timeout,
        rejectUnauthorized: cfg.rejectUnauthorized,
      });
    }
  }

  // ── User ──
  createUser(p: CreateUserRequest): Promise<CreateUserResult> { return this.http.post(`${V3}/user/create`, body(p)); }
  getUser(query: string | GetUserRequest): Promise<UserPublic> {
    const payload = typeof query === "string" ? { user_id: query } : query;
    return this.http.post(`${V3}/user/get`, body(payload));
  }
  deleteUsers(userIds: string[]): Promise<BatchDeleteResult> { return this.http.post(`${V3}/user/delete`, { user_ids: userIds }); }
  listUsers(teamId: string, pagination?: PaginationInput): Promise<PaginatedResult<UserPublic>>;
  listUsers(request: ListUsersRequest): Promise<PaginatedResult<UserPublic>>;
  listUsers(
    teamIdOrRequest: string | ListUsersRequest,
    pagination?: PaginationInput,
  ): Promise<PaginatedResult<UserPublic>> {
    if (typeof teamIdOrRequest === "string") {
      return this.http.post(`${V3}/user/list`, body({ team_id: teamIdOrRequest, ...pagination }));
    }
    return this.http.post(`${V3}/user/list`, body(teamIdOrRequest));
  }

  // ── UserKey ──
  createUserKey(p: CreateUserKeyRequest): Promise<UserKeyCreated> { return this.http.post(`${V3}/user-key/create`, body(p)); }
  listUserKeys(userId: string, pagination?: PaginationInput): Promise<PaginatedResult<UserKeyPublic>>;
  listUserKeys(request: ListUserKeysRequest): Promise<PaginatedResult<UserKeyPublic>>;
  listUserKeys(
    userIdOrRequest: string | ListUserKeysRequest,
    pagination?: PaginationInput,
  ): Promise<PaginatedResult<UserKeyPublic>> {
    if (typeof userIdOrRequest === "string") {
      return this.http.post(`${V3}/user-key/list`, body({ user_id: userIdOrRequest, ...pagination }));
    }
    return this.http.post(`${V3}/user-key/list`, body(userIdOrRequest));
  }
  getUserKey(keyId: string): Promise<UserKeyPublic> { return this.http.post(`${V3}/user-key/get`, { key_id: keyId }); }
  revokeUserKey(keyId: string): Promise<{ ok: true }> { return this.http.post(`${V3}/user-key/revoke`, { key_id: keyId }); }
  updateUserKey(p: UpdateUserKeyRequest): Promise<UserKeyPublic> { return this.http.post(`${V3}/user-key/update`, body(p)); }

  // ── Team ──
  createTeam(p: CreateTeamRequest): Promise<TeamEntity> { return this.http.post(`${V3}/team/create`, body(p)); }
  getTeam(teamId: string): Promise<TeamEntity> { return this.http.post(`${V3}/team/get`, { team_id: teamId }); }
  updateTeam(p: UpdateTeamRequest): Promise<TeamEntity> { return this.http.post(`${V3}/team/update`, body(p)); }
  deleteTeams(teamIds: string[]): Promise<BatchDeleteResult> { return this.http.post(`${V3}/team/delete`, { team_ids: teamIds }); }
  listTeams(userId: string, pagination?: PaginationInput): Promise<PaginatedResult<TeamEntity>>;
  listTeams(request: ListTeamsRequest): Promise<PaginatedResult<TeamEntity>>;
  listTeams(
    userIdOrRequest: string | ListTeamsRequest,
    pagination?: PaginationInput,
  ): Promise<PaginatedResult<TeamEntity>> {
    const payload = body(
      typeof userIdOrRequest === "string"
        ? { user_id: userIdOrRequest, ...pagination }
        : userIdOrRequest,
    );
    requireAnyString(payload, ["user_id", "user_key"], "listTeams");
    return this.http.post(`${V3}/team/list`, payload);
  }

  // ── TeamMember ──
  addTeamMember(p: AddTeamMemberRequest): Promise<TeamMemberEntity> { return this.http.post(`${V3}/team-member/add`, body(p)); }
  removeTeamMember(teamId: string, userId: string): Promise<{ ok: true }> { return this.http.post(`${V3}/team-member/remove`, { team_id: teamId, user_id: userId }); }
  listTeamMembers(teamId: string, pagination?: PaginationInput): Promise<PaginatedResult<TeamMemberEntity>> {
    return this.http.post(`${V3}/team-member/list`, body({ team_id: teamId, ...pagination }));
  }
  getTeamMember(teamId: string, userId: string): Promise<TeamMemberEntity> { return this.http.post(`${V3}/team-member/get`, { team_id: teamId, user_id: userId }); }

  // ── Agent ──
  createAgent(p: CreateAgentRequest): Promise<AgentEntity> { return this.http.post(`${V3}/agent/create`, body(p)); }
  getAgent(agentId: string): Promise<AgentEntity> { return this.http.post(`${V3}/agent/get`, { agent_id: agentId }); }
  updateAgent(p: UpdateAgentRequest): Promise<AgentEntity> { return this.http.post(`${V3}/agent/update`, body(p)); }
  deleteAgents(agentIds: string[]): Promise<BatchDeleteResult> { return this.http.post(`${V3}/agent/delete`, { agent_ids: agentIds }); }
  listAgents(p: ListAgentsRequest): Promise<PaginatedResult<AgentEntity>> { return this.http.post(`${V3}/agent/list`, body(p)); }
  archiveAgent(agentId: string): Promise<AgentEntity> { return this.http.post(`${V3}/agent/archive`, { agent_id: agentId }); }

  // ── Task ──
  createTask(p: CreateTaskRequest): Promise<TaskEntity> { return this.http.post(`${V3}/task/create`, body(p)); }
  getTask(taskId: string): Promise<TaskEntity> { return this.http.post(`${V3}/task/get`, { task_id: taskId }); }
  updateTask(p: UpdateTaskRequest): Promise<TaskEntity> { return this.http.post(`${V3}/task/update`, body(p)); }
  deleteTasks(taskIds: string[]): Promise<BatchDeleteResult> { return this.http.post(`${V3}/task/delete`, { task_ids: taskIds }); }
  listTasks(teamId: string, status?: TaskEntity["status"], pagination?: PaginationInput): Promise<PaginatedResult<TaskEntity>>;
  listTasks(request: ListTasksRequest): Promise<PaginatedResult<TaskEntity>>;
  listTasks(
    teamIdOrRequest: string | ListTasksRequest,
    status?: TaskEntity["status"],
    pagination?: PaginationInput,
  ): Promise<PaginatedResult<TaskEntity>> {
    const payload = body(
      typeof teamIdOrRequest === "string"
        ? { team_id: teamIdOrRequest, status, ...pagination }
        : teamIdOrRequest,
    );
    requireAnyString(payload, ["team_id", "creator_user_id", "creator_user_key"], "listTasks");
    return this.http.post(`${V3}/task/list`, payload);
  }
  archiveTask(taskId: string): Promise<TaskEntity> { return this.http.post(`${V3}/task/archive`, { task_id: taskId }); }

  // ── TaskAgent ──
  linkTaskAgent(taskId: string, agentId: string, roleInTask?: string): Promise<TaskAgentEntity> { return this.http.post(`${V3}/task-agent/link`, body({ task_id: taskId, agent_id: agentId, role_in_task: roleInTask })); }
  unlinkTaskAgent(taskId: string, agentId: string): Promise<{ ok: true }> { return this.http.post(`${V3}/task-agent/unlink`, { task_id: taskId, agent_id: agentId }); }
  listTaskAgents(taskId: string, pagination?: PaginationInput): Promise<PaginatedResult<TaskAgentEntity>> {
    return this.http.post(`${V3}/task-agent/list`, body({ task_id: taskId, ...pagination }));
  }

  // ── ParticipationLog ──
  appendParticipationLog(p: AppendParticipationLogRequest): Promise<ParticipationLogEntity> {
    return this.http.post(`${V3}/participation-log/append`, body(p));
  }
  listParticipationLogs(p: ListParticipationLogsRequest): Promise<PaginatedResult<ParticipationLogEntity>> {
    return this.http.post(`${V3}/participation-log/list`, body(p));
  }

  // ── Asset ──
  createAsset(p: CreateAssetRequest): Promise<AssetEntity> { return this.http.post(`${V3}/asset/create`, body(p)); }
  getAsset(assetId: string): Promise<AssetEntity> { return this.http.post(`${V3}/asset/get`, { asset_id: assetId }); }
  updateAsset(p: UpdateAssetRequest): Promise<AssetEntity> { return this.http.post(`${V3}/asset/update`, body(p)); }
  deleteAssets(assetIds: string[]): Promise<BatchDeleteResult> { return this.http.post(`${V3}/asset/delete`, { asset_ids: assetIds }); }
  listAssets(p: ListAssetsRequest): Promise<PaginatedResult<AssetEntity>> { return this.http.post(`${V3}/asset/list`, body(p)); }
  listAccessibleAssets(p: ListAccessibleAssetsRequest): Promise<PaginatedResult<AssetEntity>> {
    return this.http.post(`${V3}/asset/list-accessible`, body(p));
  }
  touchAssetUsage(assetId: string): Promise<{ ok: true }> { return this.http.post(`${V3}/asset/touch-usage`, { asset_id: assetId }); }

  // ── AgentFixedAsset ──
  setAgentFixedAssets(agentId: string, bindings: FixedAssetBindingInput[]): Promise<{ ok: true }> { return this.http.post(`${V3}/agent-fixed-asset/set`, { agent_id: agentId, bindings }); }
  listAgentFixedAssets(agentId: string, pagination?: PaginationInput): Promise<PaginatedResult<FixedAssetBindingEntity>> {
    return this.http.post(`${V3}/agent-fixed-asset/list`, body({ agent_id: agentId, ...pagination }));
  }
  listAgentFixedAssetsWithDetail(p: ListWithDetailRequest): Promise<AgentFixedAssetDetailResult> { return this.http.post(`${V3}/agent-fixed-asset/list-with-detail`, body(p)); }
  summarizeAgentFixedAssetsByAgents(p: SummarizeAgentFixedAssetsRequest): Promise<AgentFixedAssetSummaryResult> {
    return this.http.post(`${V3}/agent-fixed-asset/summary-by-agents`, body(p));
  }

  // ── ACL ──
  grantAcl(p: GrantAclRequest): Promise<AclEntity> { return this.http.post(`${V3}/acl/grant`, body(p)); }
  revokeAcl(id: string): Promise<{ ok: true }> { return this.http.post(`${V3}/acl/revoke`, { id }); }
  listAcl(assetId: string, pagination?: PaginationInput): Promise<PaginatedResult<AclEntity>> {
    return this.http.post(`${V3}/acl/list`, body({ asset_id: assetId, ...pagination }));
  }
  checkAcl(p: CheckAclRequest): Promise<PermCheckResult> { return this.http.post(`${V3}/acl/check`, body(p)); }

  // ── Auth ──
  verifyAuth(userKey: string): Promise<AuthVerifyResult> { return this.http.post(`${V3}/auth/verify`, { user_key: userKey }); }

  // ── ConfigParam (v3.2) ──
  getInstanceQuota(): Promise<InstanceQuotaLimits> { return this.http.post(`${V3}/instance-quota/get`, {}); }
  getUserConfig(p: GetUserConfigRequest): Promise<UserConfigView> { return this.http.post(`${V3}/config/user/get`, body(p)); }
  setUserConfig(p: SetUserConfigRequest): Promise<{ ok: true }> { return this.http.post(`${V3}/config/user/set`, body(p)); }

  // ── Knowledge (v3 管理面实体 CRUD，/v3/knowledge/*) ──
  // 与 team/agent 实体同构；handler 不读 user-key，team_id 在 body 里。
  createKnowledge(p: CreateKnowledgeRequest): Promise<KnowledgeEntity> { return this.http.post(`${V3_KNOWLEDGE}/create`, body(p)); }
  getKnowledge(knowledgeId: string, teamId?: string): Promise<KnowledgeEntity> {
    return this.http.post(`${V3_KNOWLEDGE}/get`, body({ knowledge_id: knowledgeId, team_id: teamId }));
  }
  updateKnowledge(p: UpdateKnowledgeRequest): Promise<KnowledgeEntity> { return this.http.post(`${V3_KNOWLEDGE}/update`, body(p)); }
  deleteKnowledge(knowledgeIds: string[], teamId?: string): Promise<BatchDeleteResult> {
    return this.http.post(`${V3_KNOWLEDGE}/delete`, body({ knowledge_ids: knowledgeIds, team_id: teamId }));
  }
  listKnowledge(p: ListKnowledgeRequest): Promise<KnowledgeListResult> { return this.http.post(`${V3_KNOWLEDGE}/list`, body(p)); }
}
