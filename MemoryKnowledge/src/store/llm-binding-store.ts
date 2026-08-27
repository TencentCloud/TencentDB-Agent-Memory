/**
 * LlmBindingStore — per-instance (service_id) LLM routing binding.
 *
 * Decoupled from IKnowledgeStore: a single small table keyed by service_id that
 * tells wiki ingest/summary which LLM endpoint to use for that instance.
 *   - mode='proxy' → route through context_proxy with a dedicated knowledge-service
 *     user_key so LLM usage is billed per instance.
 *   - mode='byo'   → user-supplied OpenAI-compatible endpoint.
 *
 * No binding (or disabled/incomplete) → behaviour depends on the global LLM_MODE:
 *   - LLM_MODE=custom → fall back to the global LLM_* (direct BYO) config.
 *   - LLM_MODE=proxy (default) → NO silent direct fallback; an "unconfigured"
 *     config is returned so wiki ingest fails loudly (forces the proxy binding
 *     chain to actually be verified instead of masking bugs).
 *
 * Model is NOT stored per-instance — it always comes from the global `LLM_MODEL`
 * env (single source of truth, see resolveLlmConfig).
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { llmBinding } from "../db/schema.js";
import type { LlmConfig } from "../config.js";

export type LlmBindingMode = "proxy" | "byo";

export interface LlmBindingRow {
  service_id: string;
  mode: LlmBindingMode;
  proxy_base_url: string | null;
  api_key: string | null;
  base_url: string | null;
  enabled: boolean;
  updated_at: string;
}

/** Upsert payload (service_id comes from the header, not the body).
 *  `api_key: undefined` 表示保留原值（用于只更新 proxy_base_url 的场景）；
 *  `api_key: null` 表示清空；`api_key: "xxx"` 表示更新。 */
export interface LlmBindingInput {
  mode: LlmBindingMode;
  proxy_base_url?: string | null;
  api_key?: string | null;
  base_url?: string | null;
  enabled?: boolean;
}

/** Read-side status (never exposes api_key). */
export interface LlmBindingStatus {
  bound: boolean;
  mode: LlmBindingMode | null;
  enabled: boolean;
}

export interface ILlmBindingStore {
  get(serviceId: string): LlmBindingRow | null;
  listAll(): LlmBindingRow[];
  upsert(serviceId: string, input: LlmBindingInput): LlmBindingRow;
  status(serviceId: string): LlmBindingStatus;
}

export function createLlmBindingStore(db: Db): ILlmBindingStore {
  return {
    get(serviceId: string): LlmBindingRow | null {
      const rows = db.select().from(llmBinding).where(eq(llmBinding.serviceId, serviceId)).all();
      const row = rows[0];
      return row ? toRow(row) : null;
    },

    listAll(): LlmBindingRow[] {
      const rows = db.select().from(llmBinding).all();
      return rows.map(toRow);
    },

    upsert(serviceId: string, input: LlmBindingInput): LlmBindingRow {
      const now = new Date().toISOString();
      const existing = this.get(serviceId);
      // api_key: undefined → 保留原值（仅 upsert 已存在记录时）；null → 清空；string → 更新
      const apiKey = input.api_key !== undefined ? input.api_key : (existing?.api_key ?? null);
      const values = {
        serviceId,
        mode: input.mode,
        proxyBaseUrl: input.proxy_base_url ?? null,
        apiKey,
        baseUrl: input.base_url ?? null,
        enabled: input.enabled === false ? 0 : 1,
        updatedAt: now,
      };
      db.insert(llmBinding)
        .values(values)
        .onConflictDoUpdate({
          target: llmBinding.serviceId,
          set: {
            mode: values.mode,
            proxyBaseUrl: values.proxyBaseUrl,
            apiKey: values.apiKey,
            baseUrl: values.baseUrl,
            enabled: values.enabled,
            updatedAt: values.updatedAt,
          },
        })
        .run();
      return this.get(serviceId)!;
    },

    status(serviceId: string): LlmBindingStatus {
      const row = this.get(serviceId);
      if (!row) return { bound: false, mode: null, enabled: false };
      return { bound: true, mode: row.mode, enabled: row.enabled };
    },
  };
}

function toRow(r: typeof llmBinding.$inferSelect): LlmBindingRow {
  return {
    service_id: r.serviceId,
    mode: (r.mode === "byo" ? "byo" : "proxy") as LlmBindingMode,
    proxy_base_url: r.proxyBaseUrl ?? null,
    api_key: r.apiKey ?? null,
    base_url: r.baseUrl ?? null,
    enabled: r.enabled !== 0,
    updated_at: r.updatedAt,
  };
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Pure resolver: turn a binding (or its absence) into an effective LlmConfig.
 * maxTokens/timeoutMs/provider/mode always inherit from the fallback; the binding
 * only overrides endpoint/key.
 *
 * Model always comes from `fallback.model` (= global `LLM_MODEL` env) — no
 * per-instance model storage, single source of truth.
 *
 * proxy mode → baseUrl = {proxy_base_url}/proxy/{service_id}/v1 (so context_proxy
 * uses service_id as x-tdai-service-id for auth/verify + per-instance billing).
 *
 * When there is no usable binding, the global default is decided by fallback.mode:
 *   - 'custom' → return the global config as-is (direct BYO).
 *   - 'proxy'  → return the global config with baseUrl/apiKey blanked, so
 *     createLlmClient throws instead of silently calling a direct endpoint.
 */
export function resolveLlmConfig(
  serviceId: string,
  binding: LlmBindingRow | null,
  fallback: LlmConfig,
): LlmConfig {
  // Global default when no per-instance binding is usable.
  const globalDefault = (): LlmConfig =>
    fallback.mode === "custom"
      ? fallback
      : { ...fallback, baseUrl: "", apiKey: "" };

  if (!binding || !binding.enabled) return globalDefault();

  if (binding.mode === "proxy") {
    if (!binding.proxy_base_url || !binding.api_key) return globalDefault();
    return {
      mode: fallback.mode,
      protocol: fallback.protocol,
      provider: fallback.provider,
      apiKey: binding.api_key,
      model: fallback.model,
      baseUrl: `${trimTrailingSlash(binding.proxy_base_url)}/proxy/${serviceId}/v1`,
      maxTokens: fallback.maxTokens,
      timeoutMs: fallback.timeoutMs,
      stream: fallback.stream,
    };
  }

  // byo
  if (!binding.base_url || !binding.api_key) return globalDefault();
  return {
    mode: fallback.mode,
    protocol: fallback.protocol,
    provider: fallback.provider,
    apiKey: binding.api_key,
    model: fallback.model,
    baseUrl: binding.base_url,
    maxTokens: fallback.maxTokens,
    timeoutMs: fallback.timeoutMs,
    stream: fallback.stream,
  };
}
