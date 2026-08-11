/**
 * API helpers — IdFields extraction, envelope wrapping, Row→Detail serialization.
 *
 * Shared by all Hono route modules to keep the HTTP layer thin.
 */

import type { CodeGraphRow, WikiRow } from "./store/index.js";

// ───────────────────────── IdFields ─────────────────────────

/** HTTP header carrying the tenant identity (service_id). */
export const SERVICE_ID_HEADER = "x-tdai-service-id";

/**
 * Whitelist for id segments that get concatenated into filesystem paths
 * (`data/{service_id}/{team_id}/{resource_id}/`). Even with auth disabled
 * (001 Q2), this MUST be enforced to prevent path traversal (001 R5):
 * only `A-Za-z0-9_-`, non-empty, bounded length.
 */
const ID_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const ID_SEGMENT_MAX = 200;

/** True if `id` is a safe path segment (whitelist + bounded). */
export function isValidIdSegment(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= ID_SEGMENT_MAX &&
    ID_SEGMENT_PATTERN.test(id)
  );
}

/**
 * Validate the `service_id` tenant identity taken from the `x-tdai-service-id`
 * header. Returns the value or null when missing/malformed (route → 400).
 * service_id 自报（内网信任，001 Q2/Q7），统一走 header（= 内核 x-tdai-service-id）。
 */
export function extractServiceId(headerValue: string | undefined | null): string | null {
  return isValidIdSegment(headerValue) ? headerValue : null;
}

export interface IdFields {
  service_id: string;
  team_id: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
}

/**
 * Extract IdFields: `service_id` from the `x-tdai-service-id` header,
 * `team_id` from the request body. Both required AND valid path segments (R5);
 * the rest are optional body fields.
 * @returns IdFields or null (when service_id/team_id missing or malformed).
 */
export function extractIdFields(
  serviceIdHeader: string | undefined | null,
  body: Record<string, unknown>,
): IdFields | null {
  const serviceId = extractServiceId(serviceIdHeader);
  if (serviceId === null) return null;
  const teamId = body.team_id;
  if (!isValidIdSegment(teamId)) return null;
  const fields: IdFields = { service_id: serviceId, team_id: teamId };
  if (typeof body.user_id === "string" && body.user_id) fields.user_id = body.user_id;
  if (typeof body.agent_id === "string" && body.agent_id) fields.agent_id = body.agent_id;
  if (typeof body.task_id === "string" && body.task_id) fields.task_id = body.task_id;
  return fields;
}

// ───────────────────────── ApiResponseEnvelope ─────────────────────────

export interface ApiResponseEnvelope<T = unknown> {
  code: number;
  message: string;
  request_id?: string;
  data: T | null;
}

export function wrapOk<T>(data: T, requestId?: string): ApiResponseEnvelope<T> {
  return { code: 0, message: "ok", ...(requestId ? { request_id: requestId } : {}), data };
}

export function wrapError(code: number, message: string, requestId?: string): ApiResponseEnvelope<null> {
  return { code, message, ...(requestId ? { request_id: requestId } : {}), data: null };
}

// ───────────────────────── Version ─────────────────────────

export function toExternalVersion(v: number): string {
  return String(v);
}

// ───────────────────────── WikiDetail ─────────────────────────

export interface WikiDetail {
  wiki_id: string;
  team_id: string;
  name: string;
  service_url: string | null;
  summary: string | null;
  status: string;
  internal_status: string | null;
  sync_error: string | null;
  version: string;
  owner_user_id: string | null;
  page_count: number | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toWikiDetail(row: WikiRow): WikiDetail {
  return {
    wiki_id: row.wiki_id,
    team_id: row.team_id,
    name: row.name,
    service_url: row.service_url ?? null,
    summary: row.summary ?? null,
    status: row.status,
    internal_status: row.internal_status,
    sync_error: row.sync_error,
    version: toExternalVersion(row.version),
    owner_user_id: row.owner_user_id,
    page_count: row.page_count ?? null,
    last_sync_at: row.last_sync_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ───────────────────────── CodeGraphDetail ─────────────────────────

export interface CodeGraphStats {
  files: number;
  nodes: number;
  edges: number;
}

export interface CodeGraphDetail {
  code_graph_id: string;
  team_id: string;
  repo_name: string;
  repo_url: string;
  branch: string;
  sparse_paths: string[];
  commit_hash: string | null;
  service_url: string | null;
  summary: string | null;
  status: string;
  sync_error: string | null;
  version: string;
  owner_user_id: string | null;
  stats: CodeGraphStats | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toCodeGraphDetail(row: CodeGraphRow): CodeGraphDetail {
  let stats: CodeGraphStats | null = null;
  if (row.stats_json) {
    try {
      stats = JSON.parse(row.stats_json) as CodeGraphStats;
    } catch {
      // malformed json — treat as null
    }
  }
  return {
    code_graph_id: row.code_graph_id,
    team_id: row.team_id,
    repo_name: row.repo_name,
    repo_url: row.repo_url,
    branch: row.branch,
    sparse_paths: row.sparse_paths,
    commit_hash: row.commit_hash,
    service_url: row.service_url ?? null,
    summary: row.summary ?? null,
    status: row.status,
    sync_error: row.sync_error,
    version: toExternalVersion(row.version),
    owner_user_id: row.owner_user_id,
    stats,
    last_sync_at: row.last_sync_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ───────────────────────── BatchDeleteResult ─────────────────────────

export interface BatchDeleteResult {
  deleted_ids: string[];
  failed: Array<{ id: string; reason: string }>;
}
