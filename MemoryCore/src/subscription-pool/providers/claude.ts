import type { SubscriptionQuotaWindow } from "../../metadata/types.js";
import {
  parseResetTime,
  readProviderError,
  type ExchangedSubscriptionTokens,
  type SubscriptionCodeExchangeInput,
  type SubscriptionFetch,
  type SubscriptionProviderAdapter,
} from "./types.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPE = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins";
const OAUTH_BETA = "oauth-2025-04-20";

const FLAT_WINDOWS = [
  "five_hour",
  "seven_day",
  "seven_day_oauth_apps",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_fable",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function windowOf(name: string, raw: unknown, now: number, modelScope: string | null = null): SubscriptionQuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { utilization?: number; percent?: number; resets_at?: unknown };
  const used = typeof value.utilization === "number" ? value.utilization : value.percent;
  if (typeof used !== "number") return null;
  return {
    name,
    model_scope: modelScope,
    used_pct: used,
    resets_at: parseResetTime(value.resets_at, now),
    observed_at: now,
    source: "usage_api",
  };
}

/**
 * Usage payload of the Claude OAuth usage API.
 * `limits[]` is the current shape. Flat windows are the older shape and are used only when
 * `limits` is absent.
 */
export function parseClaudeUsage(raw: unknown, now = Date.now()): SubscriptionQuotaWindow[] {
  const body = asRecord(raw);
  if (Array.isArray(body.limits) && body.limits.length > 0) {
    const windows: SubscriptionQuotaWindow[] = [];
    for (const item of body.limits) {
      const row = asRecord(item);
      if (row.is_active === false) continue;
      const kind = String(row.kind ?? "");
      const scope = asRecord(row.scope);
      const model = asRecord(scope.model);
      const modelId = typeof model.id === "string" && model.id ? model.id : null;
      const shared = kind === "session" || kind === "weekly_all" || !modelId;
      const name = kind === "session" ? "five_hour" : kind === "weekly_all" ? "seven_day" : (kind || "limit");
      const parsed = windowOf(name, { percent: row.percent, resets_at: row.resets_at }, now, shared ? null : modelId);
      if (parsed) windows.push(parsed);
    }
    return windows;
  }
  return FLAT_WINDOWS
    .map((name) => windowOf(name, body[name], now))
    .filter((window): window is SubscriptionQuotaWindow => window !== null);
}

async function postToken(fetchImpl: SubscriptionFetch, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await readProviderError(response);
  return await response.json() as Record<string, unknown>;
}

function labelOf(email: string, plan: string): string {
  return [email, plan].filter(Boolean).join(" ");
}

function identityFromTokenBody(body: Record<string, unknown>): { providerAccountId: string; accountLabel: string } {
  const account = asRecord(body.account);
  const organization = asRecord(body.organization);
  const email = String(account.email_address ?? account.email ?? "");
  const plan = String(organization.organization_type ?? "");
  return { providerAccountId: String(account.uuid ?? ""), accountLabel: labelOf(email, plan) };
}

function expiresAtOf(body: Record<string, unknown>, now: number): number | null {
  const expiresIn = Number(body.expires_in);
  return Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null;
}

function tokensFrom(
  body: Record<string, unknown>,
  identity: { providerAccountId: string; accountLabel: string },
  now: number,
): ExchangedSubscriptionTokens {
  return {
    accessToken: String(body.access_token ?? ""),
    refreshToken: String(body.refresh_token ?? ""),
    expiresAt: expiresAtOf(body, now),
    providerAccountId: identity.providerAccountId,
    accountLabel: identity.accountLabel,
  };
}

export function createClaudeAdapter(fetchImpl: SubscriptionFetch = fetch): SubscriptionProviderAdapter {
  async function profileOf(accessToken: string): Promise<{ providerAccountId: string; accountLabel: string }> {
    const response = await fetchImpl(PROFILE_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw await readProviderError(response);
    const body = asRecord(await response.json());
    const account = asRecord(body.account);
    const organization = asRecord(body.organization);
    return {
      providerAccountId: String(account.uuid ?? ""),
      accountLabel: labelOf(String(account.email ?? account.display_name ?? ""), String(organization.organization_type ?? "")),
    };
  }

  return {
    provider: "claude",
    async exchangeCode(input: SubscriptionCodeExchangeInput) {
      const body = await postToken(fetchImpl, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri || REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: input.codeVerifier,
        state: input.state,
      });
      let identity = identityFromTokenBody(body);
      const accessToken = String(body.access_token ?? "");
      if (!identity.providerAccountId && accessToken) identity = await profileOf(accessToken);
      if (!identity.providerAccountId) throw new Error("claude token has no account id");
      return tokensFrom(body, identity, Date.now());
    },
    async refresh(refreshToken: string) {
      const body = await postToken(fetchImpl, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: SCOPE,
      });
      return tokensFrom(body, { providerAccountId: "", accountLabel: "" }, Date.now());
    },
    async fetchUsage(accessToken: string) {
      const response = await fetchImpl(USAGE_URL, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw await readProviderError(response);
      return parseClaudeUsage(await response.json());
    },
  };
}

export const CLAUDE_OAUTH = {
  CLIENT_ID,
  REDIRECT_URI,
  SCOPE,
  AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize",
  extraParams: { code: "true" } as Record<string, string>,
};
