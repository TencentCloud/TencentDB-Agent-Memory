/**
 * Instance-level master switch "team_memory.enabled".
 *
 * Reads the scope=global row from Core via the existing user-scope endpoint
 * `POST /v3/meta/config/user/get` with `module="team_memory"`. The param has
 * `allowed_scopes=["global"]`, so Core's getEffectiveParam skips the user row
 * lookup and directly returns the global value (or the registry default "1").
 *
 * Mirrors `fetchAssetCapabilities`:
 *   - Per-request call, no local cache (cache lives in Core's ConfigParamService
 *     at 1min TTL).
 *   - Every failure path (timeout, HTTP 5xx, envelope error, parse error, empty
 *     items, garbage value, missing userId) falls back to `true` so an older
 *     Core without the team_memory module is 100% backward compatible.
 *
 * See `MemoryProxy/docs/design/2026-10-13-team-memory-master-switch.md` §4-§6.
 */

export const DEFAULT_TEAM_MEMORY_ENABLED = true;

export interface FetchTeamMemoryEnabledInput {
  endpoint: string;
  apiKey: string;
  /** instance_id, sent as x-tdai-service-id. */
  instanceId: string;
  /** user_key for the caller (required by Core auth; may be the SA bootstrap key). */
  userKey?: string | null;
  /** user_id, required by Core schema; falls back to true if missing. */
  userId?: string | null;
  /** fetch timeout; default 5000ms. */
  timeoutMs?: number;
}

interface ConfigUserGetEnvelope {
  code?: number;
  message?: string;
  data?: {
    items?: Array<{
      param_name?: string;
      effective_value?: string;
    }>;
  };
}

function parseEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value.toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined; // unknown shape → caller falls back to default
}

export async function fetchTeamMemoryEnabled(input: FetchTeamMemoryEnabledInput): Promise<boolean> {
  const userId = input.userId?.trim();
  if (!userId) return DEFAULT_TEAM_MEMORY_ENABLED;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${input.apiKey}`,
      "x-tdai-service-id": input.instanceId,
      "content-type": "application/json",
    };
    if (input.userKey) headers["x-tdai-user-key"] = input.userKey;

    const resp = await fetch(`${input.endpoint.replace(/\/+$/, "")}/v3/meta/config/user/get`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user_id: userId,
        module: "team_memory",
        param_name: "enabled",
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn(`[team-memory-switch] HTTP ${resp.status}: ${text.slice(0, 200)}`);
      return DEFAULT_TEAM_MEMORY_ENABLED;
    }

    const env = (await resp.json()) as ConfigUserGetEnvelope;
    if (env.code !== 0) {
      console.warn(`[team-memory-switch] envelope code=${env.code}: ${env.message ?? ""}`);
      return DEFAULT_TEAM_MEMORY_ENABLED;
    }

    const items = env.data?.items ?? [];
    const row = items.find((it) => it.param_name === "enabled");
    const parsed = parseEnabled(row?.effective_value);
    return parsed === undefined ? DEFAULT_TEAM_MEMORY_ENABLED : parsed;
  } catch (err) {
    console.warn(`[team-memory-switch] fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return DEFAULT_TEAM_MEMORY_ENABLED;
  } finally {
    clearTimeout(timer);
  }
}
