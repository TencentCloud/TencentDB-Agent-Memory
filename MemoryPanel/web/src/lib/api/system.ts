/**
 * api/system.ts — 面板新增「模型管理 / 向量检索 / 系统状态」三个菜单的前端接口层。
 *
 * 与 lib/api/base.ts 的 metaPost 的区别：
 *   - metaPost 走 /api/v1/meta/{action}（内核透明代理，用于上游分组 CRUD）；
 *   - 本文件走 /api/v1/system/* 与 /api/v1/upstream/*（面板自有业务路由）。
 * 两者鉴权方式一致：Header 注入 X-Tdai-Service-Id + X-Tdai-User-Key。
 */
import { getPanelSession } from '../panelSession';
import { request, unwrapEnvelope } from './base';
import type { MetaEnvelope } from './types';

function authHeaders(): Record<string, string> {
  const session = getPanelSession();
  const headers: Record<string, string> = {};
  if (session?.instanceId) headers['X-Tdai-Service-Id'] = session.instanceId;
  if (session?.userKey) headers['X-Tdai-User-Key'] = session.userKey;
  return headers;
}

// ── 模型管理 ────────────────────────────────────────────────────────────────

/** 内核返回的 supported-agents 条目 */
export interface SupportedAgent {
  agent_source: string;
  protocol: string;
  display_name: string;
}

/** instance-upstream 组（groups/list 的一行） */
export interface UpstreamGroup {
  group_id: string;
  group_type: 'default' | 'custom' | 'extraction';
  name: string;
  agents: string[];
  enabled: boolean;
  mode: 'official' | 'custom_unified' | 'custom_passthrough';
  base_url: string;
  /** 内核对 /v3/meta 接口已做脱敏；不保证存在，优先读 api_key_masked */
  api_key?: string;
  /** 内核返回的脱敏字段（实际存在的是这个） */
  api_key_masked?: string;
  model_id?: string;
  /** 多模型清单（P1）：非空时客户端只能看到/选用清单内模型，[0] 为默认 */
  model_ids?: string[];
  /** 团队专属（P3）：空 = 全局组 */
  team_id?: string;
  description?: string;
  version?: number;
}

export interface UpstreamTestResult {
  ok: boolean;
  status: number;
  statusText: string;
  latencyMs: number;
  requestUrl: string;
  modelEcho: string;
  responsePreview: string;
}

// ── 系统状态 ────────────────────────────────────────────────────────────────

export interface ComponentHealth {
  name: string;
  status: 'ok' | 'warn' | 'down' | 'unknown';
  detail: string;
  latencyMs?: number;
}

export interface HealthResult {
  checks: ComponentHealth[];
  generatedAt: string;
}

export interface ConfigSection {
  source: string;
  path: string;
  exists: boolean;
  data: string | null;
}

export interface UsageItem {
  spaceId: string;
  agent: string;
  groupId: string;
  groupName: string;
  model: string;
  /** 团队归属（P4）：空 = 全局组流量 */
  teamId?: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** 按平台价目表折算的参考值，非账单金额 */
  equivalentCredit: number;
  unpricedTokens: number;
  lastAt: string;
}

export interface UsageResult {
  note: string;
  /** 恒为 false：自定义上游流量不计入平台账单 */
  billedToPlatform: boolean;
  generatedAt: string;
  items: UsageItem[];
  totals: Omit<UsageItem, 'spaceId' | 'agent' | 'groupId' | 'groupName' | 'model' | 'teamId' | 'lastAt'>;
}

// ── 向量检索 ────────────────────────────────────────────────────────────────

export interface VectorConfig {
  path: string;
  provider: string;
  baseUrl: string;
  model: string;
  /** 脱敏后的密钥 */
  apiKey: string;
  dimensions: string;
  enabled: string;
  restartRequired: boolean;
}

export interface VectorSaveResult {
  ok: boolean;
  updated: string[];
  backupPath: string;
  restartRequired: boolean;
  restartHint: string;
}

async function get<T>(path: string): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('GET', path, undefined, authHeaders());
  return unwrapEnvelope(envelope, 'empty response');
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('POST', path, body, authHeaders());
  return unwrapEnvelope(envelope, 'empty response');
}

export const systemApi = {
  health: () => get<HealthResult>('/api/v1/system/health'),
  config: () => get<{ sections: ConfigSection[] }>('/api/v1/system/config'),
  usage: () => get<UsageResult>('/api/v1/system/usage'),
  vector: () => get<VectorConfig>('/api/v1/system/vector'),
  saveVector: (body: Record<string, unknown>) =>
    post<VectorSaveResult>('/api/v1/system/vector', body),
  testUpstream: (body: Record<string, unknown>) =>
    post<UpstreamTestResult>('/api/v1/upstream/test', body),
  /** P1：拉取供应商模型列表（OpenAI/Anthropic 兼容 GET {base}/models） */
  listUpstreamModels: (body: Record<string, unknown>) =>
    post<{ ok: boolean; models: string[]; error?: string }>('/api/v1/upstream/models', body),
};
