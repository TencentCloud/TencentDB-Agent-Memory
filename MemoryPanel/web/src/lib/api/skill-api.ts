/**
 * skill-api.ts — Skill 数据面 API 客户端。
 *
 * 对接文档：见团队内部知识库 Skill API 章节
 * 14 个 POST 接口，前端走 Panel 后端代理 `/api/v1/skill/`，由 Panel 再转发到记忆 Gateway `/v3/skill/`。
 * 鉴权 Header：`X-Tdai-Service-Id` + `X-Tdai-User-Key`（与 meta API 一致）。
 *
 * 统一信封 `{ code, message, request_id, data }`，code === 0 为成功。
 */

import { getPanelSession } from '../panelSession';
import { formatApiErrorMessage } from '../error-message';
import i18n from '@/i18n';

// ========================= Envelope =========================

export interface SkillEnvelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

export class SkillApiError extends Error {
  code: number;
  requestId: string;
  rawMessage: string;

  constructor(code: number, message: string, requestId: string) {
    super(formatApiErrorMessage({ code, message, requestId }));
    this.name = 'SkillApiError';
    this.code = code;
    this.requestId = requestId;
    this.rawMessage = message;
  }
}

// ========================= Types =========================

/** 列表/搜索结果的基础形态 */
export interface SkillSummary {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  is_head: boolean;
  status: 'active' | 'archived';
  owner_user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  metadata?: Record<string, unknown>;
}

/** get 接口返回，包含完整内容 */
export interface SkillDetail extends SkillSummary {
  content: string;
  manifest: SkillManifestEntry[];
  content_hash?: string;
  storage_dir?: string;
}

export interface SkillManifestEntry {
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

/** 资源文件入参 */
export interface SkillResourcePayload {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime_type?: string;
  is_executable?: boolean;
}

/** 搜索命中结果 */
export interface SkillSearchHit extends SkillSummary {
  score: number;
  snippet: string;
}

// ========================= Base Request =========================

const SKILL_PREFIX = '/api/v1/skill';

/** 去除 body 中值为空字符串或 undefined 的字段（v3 校验要求字符串字段要么不传，要么非空） */
function stripEmpty(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === '' || v === undefined) continue;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const nested = stripEmpty(v as Record<string, unknown>);
      if (Object.keys(nested).length > 0) out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function skillCall<T>(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const session = getPanelSession();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (session) {
    headers['X-Tdai-Service-Id'] = session.instanceId;
    headers['X-Tdai-User-Key'] = session.userKey;
  }
  const res = await fetch(`${SKILL_PREFIX}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(stripEmpty(body)),
    signal,
  });
  if (res.status === 401) {
    throw new SkillApiError(401, i18n.t('skillApi.error.unauthorized'), '');
  }
  const text = await res.text();
  let envelope: SkillEnvelope<T>;
  try {
    envelope = JSON.parse(text) as SkillEnvelope<T>;
  } catch {
    throw new SkillApiError(res.status || 500, text || res.statusText || 'Skill request failed', '');
  }
  if (!res.ok || envelope.code !== 0) {
    throw new SkillApiError(envelope.code ?? res.status, envelope.message || res.statusText, envelope.request_id);
  }
  return envelope.data;
}

// ========================= API Functions =========================

// ---- 3.1 create ----

export function createSkill(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  task_id?: string;
  name: string;
  content: string;
  resources?: SkillResourcePayload[];
  metadata?: Record<string, unknown>;
}): Promise<SkillSummary> {
  return skillCall('create', params as unknown as Record<string, unknown>);
}

// ---- 3.2 update ----

export function updateSkill(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  skill_id: string;
  expected_version: number;
  content: string;
}): Promise<SkillSummary> {
  return skillCall('update', params as unknown as Record<string, unknown>);
}

// ---- 3.3 patch ----

export function patchSkill(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  skill_id: string;
  expected_version: number;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}): Promise<SkillSummary> {
  return skillCall('patch', params as unknown as Record<string, unknown>);
}

// ---- 3.4 delete ----

export function deleteSkillV3(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  skill_id: string;
  expected_version: number;
}): Promise<{ skill_id: string; archived: boolean }> {
  return skillCall('delete', params as unknown as Record<string, unknown>);
}

// ---- 3.5 get ----

export interface GetSkillParams {
  user_id?: string;
  team_id?: string;
  skill_id: string;
  version?: number;
  include_content?: boolean;
  include_manifest?: boolean;
}

export function getSkill(params: GetSkillParams): Promise<SkillDetail> {
  return skillCall('get', {
    user_id: params.user_id ?? '',
    team_id: params.team_id ?? '',
    skill_id: params.skill_id,
    version: params.version,
    include_content: params.include_content ?? true,
    include_manifest: params.include_manifest ?? true,
  });
}

// ---- 3.6 list ----

export interface ListSkillFilters {
  owner_agent_id?: string;
  name_prefix?: string;
  status?: string[];
}

export interface ListSkillParams {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  filters?: ListSkillFilters;
  pagination?: { limit?: number; offset?: number };
}

export interface ListSkillResult {
  items: SkillSummary[];
  total: number;
}

export function listSkills(params: ListSkillParams): Promise<ListSkillResult> {
  return skillCall('list', {
    user_id: params.user_id ?? '',
    team_id: params.team_id ?? '',
    agent_id: params.agent_id ?? '',
    filters: params.filters ?? {},
    pagination: params.pagination ?? { limit: 100, offset: 0 },
  });
}

// ---- 3.7 search ----

export interface SearchSkillParams {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  query: string;
  top_k?: number;
  mode?: 'bm25' | 'embedding' | 'hybrid';
  scope?: 'team';
}

export interface SearchSkillResult {
  items: SkillSearchHit[];
}

export function searchSkills(params: SearchSkillParams): Promise<SearchSkillResult> {
  return skillCall('search', params as unknown as Record<string, unknown>);
}

// ---- 3.8 versions ----

export interface VersionsResult {
  items: SkillSummary[];
  total: number;
}

export function listSkillVersions(params: {
  user_id?: string;
  team_id?: string;
  skill_id: string;
  pagination?: { limit?: number; offset?: number };
}): Promise<VersionsResult> {
  return skillCall('versions', {
    user_id: params.user_id ?? '',
    team_id: params.team_id ?? '',
    skill_id: params.skill_id,
    pagination: params.pagination ?? { limit: 100, offset: 0 },
  });
}

// ---- 3.9 files/write ----

export function writeSkillFiles(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  skill_id: string;
  expected_version: number;
  files: SkillResourcePayload[];
}): Promise<SkillSummary> {
  return skillCall('files/write', params as unknown as Record<string, unknown>);
}

// ---- 3.10 files/remove ----

export function removeSkillFiles(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  skill_id: string;
  expected_version: number;
  paths: string[];
}): Promise<SkillSummary> {
  return skillCall('files/remove', params as unknown as Record<string, unknown>);
}

// ---- 3.11 files/read ----

export interface ReadFileResult {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size_bytes: number;
  mime_type: string;
  version: number;
}

export function readSkillFile(params: {
  user_id?: string;
  team_id?: string;
  skill_id: string;
  version?: number;
  path: string;
  encoding?: 'utf-8' | 'base64';
}): Promise<ReadFileResult> {
  return skillCall('files/read', {
    user_id: params.user_id ?? '',
    team_id: params.team_id ?? '',
    skill_id: params.skill_id,
    version: params.version,
    path: params.path,
    encoding: params.encoding,
  });
}

// ---- 3.12 listing ----

export interface ListingResult {
  mode: 'full' | 'search';
  listing: string;
  hits: Array<{ skill_id: string; version: number; name: string }>;
}

export function getSkillListing(params: {
  user_id?: string;
  team_id?: string;
  agent_id: string;
  query?: string;
  char_budget?: number;
}): Promise<ListingResult> {
  return skillCall('listing', params as unknown as Record<string, unknown>);
}

// ---- 3.13 extract ----

/**
 * `/v3/skill/extract` 入参（space_id 已转 optional）：
 *   - user_id / team_id / agent_id：必填
 *   - space_id：**前端不传**。跟其他 12 个 skill 接口一致, 从 `X-Tdai-Service-Id`
 *     header (= panelSession.instanceId) 走; 后端 handler 用 `auth.serviceId` 兜底。
 *   - session_id：可选，缺省时后端生成 `sx-<8hex>`
 *   - task_id：可选，透传为 SkillTaskEntry.task_ref_id（业务 ref，与归档 task_id 不同）
 *   - reason / options.max_iterations：透传给主 agent extractor prompt
 *   - role 新增 `system`（对齐 conversation/add 的 5 种 role）
 */
export interface ExtractParams {
  user_id: string;
  team_id: string;
  agent_id: string;
  task_id?: string;
  session_id?: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';
    content: string;
    tool_name?: string;
    tool_call_id?: string;
  }>;
  reason?: string;
  options?: { max_iterations?: number };
}

/**
 * `/v3/skill/extract` 返回体：
 *   - 后端恒走 archive → agent 队列 → worker 异步链路，永远返回 task_id；
 *     老版本的 `{mode:'sync', candidates}` 已被移除。
 *   - task_id 是**归档 task_id**（`task-<uuid8>`），跟入参 task_id (业务 task_ref_id) 是两个字段。
 *   - archive_key 是 COS 归档路径（含 `/skill_buffer/{user}/{team}/{agent}/{session}/`）。
 */
export interface ExtractResult {
  ok: true;
  task_id: string;
  archived_at_ms: number;
  archive_key: string;
}

export function extractSkills(params: ExtractParams): Promise<ExtractResult> {
  return skillCall('extract', params as unknown as Record<string, unknown>);
}

// ---- 3.14 export ----

export interface ExportSkillParams {
  user_id?: string;
  team_id?: string;
  skill_id: string;
  version?: number;
  format?: 'zip';
}

export interface ExportSkillResult {
  zip_base64: string;
  filename: string;
  name: string;
  version: number;
  file_count: number;
  total_bytes: number;
  warnings: string[];
}

const EXPORT_TIMEOUT_MS = 30_000;

export function exportSkill(params: ExportSkillParams, signal?: AbortSignal): Promise<ExportSkillResult> {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(EXPORT_TIMEOUT_MS) : undefined;
  // 合并外部 signal 与内部超时
  const effectiveSignal = signal && timeout
    ? AbortSignal.any?.([signal, timeout]) ?? timeout
    : (signal ?? timeout);

  return skillCall('export', {
    user_id: params.user_id ?? '',
    team_id: params.team_id ?? '',
    skill_id: params.skill_id,
    version: params.version,
    format: params.format,
  }, effectiveSignal);
}

// ---- 3.15 extract/result (deprecated) ----
//
// `/v3/skill/extract/result` 已下线。SkillCoreSink 会在 worker
// drain 后直接把 skill 写入表，提取结果通过 `/v3/skill/list` 拿到（不再有独立
// 的 result 查询接口）。前端拿到 extract 的 task_id 即视为"任务已受理"。
