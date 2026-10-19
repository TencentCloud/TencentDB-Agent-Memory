import type { SubscriptionQuotaWindow } from "../../metadata/types.js";
import {
  parseResetTime,
  readProviderError,
  type ExchangedSubscriptionTokens,
  type SubscriptionCodeExchangeInput,
  type SubscriptionFetch,
  type SubscriptionProviderAdapter,
} from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Codex refresh responses usually omit `expires_in`; the access token JWT `exp` is the source of truth then. */
function expiresAtOf(body: Record<string, unknown>, accessToken: string, now: number): number | null {
  const expiresIn = Number(body.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return now + expiresIn * 1000;
  const exp = Number(decodeJwtPayload(accessToken).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

function identityFromIdToken(idToken: string): { providerAccountId: string; accountLabel: string } {
  const payload = decodeJwtPayload(idToken);
  const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const profile = payload["https://api.openai.com/profile"] as { email?: string } | undefined;
  const accountId = String(auth?.chatgpt_account_id ?? "");
  const plan = String(auth?.chatgpt_plan_type ?? "");
  const email = String(profile?.email ?? payload.email ?? "");
  return { providerAccountId: accountId, accountLabel: [email, plan].filter(Boolean).join(" ") };
}

function windowOf(name: string, raw: unknown, now: number): SubscriptionQuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { used_percent?: number; reset_at?: unknown; reset_after_seconds?: number };
  // A row without a usage percent is a shape this parser does not know; storing it as 0 % would hide a limit.
  if (typeof value.used_percent !== "number") return null;
  const resetAt = parseResetTime(value.reset_at, now) ?? (
    typeof value.reset_after_seconds === "number" ? now + value.reset_after_seconds * 1000 : null
  );
  return {
    name,
    model_scope: null,
    used_pct: Number(value.used_percent ?? 0),
    resets_at: resetAt,
    observed_at: now,
    source: "usage_api",
  };
}

export function parseCodexUsage(raw: unknown, now = Date.now()): SubscriptionQuotaWindow[] {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rate = body.rate_limit as { primary_window?: unknown; secondary_window?: unknown } | undefined;
  const windows = [
    windowOf("primary_window", rate?.primary_window, now),
    windowOf("secondary_window", rate?.secondary_window, now),
  ].filter((window): window is SubscriptionQuotaWindow => window !== null);
  const extra = body.additional_rate_limits;
  if (Array.isArray(extra)) {
    for (const item of extra) {
      const row = item as { name?: string; limit_name?: string; model?: string; primary_window?: unknown; rate_limit?: { primary_window?: unknown } };
      const parsed = windowOf(String(row.limit_name ?? row.name ?? "additional"), row.rate_limit?.primary_window ?? row.primary_window ?? row, now);
      if (!parsed) continue;
      parsed.model_scope = row.model ?? null;
      windows.push(parsed);
    }
  }
  return windows;
}

async function postToken(fetchImpl: SubscriptionFetch, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await readProviderError(response);
  return await response.json() as Record<string, unknown>;
}

function tokensFrom(body: Record<string, unknown>, now: number, previousAccountId = ""): ExchangedSubscriptionTokens {
  const idToken = String(body.id_token ?? "");
  const identity = idToken ? identityFromIdToken(idToken) : { providerAccountId: previousAccountId, accountLabel: "" };
  const accessToken = String(body.access_token ?? "");
  return {
    accessToken,
    refreshToken: String(body.refresh_token ?? ""),
    expiresAt: expiresAtOf(body, accessToken, now),
    providerAccountId: identity.providerAccountId || previousAccountId,
    accountLabel: identity.accountLabel,
  };
}

export function createCodexAdapter(fetchImpl: SubscriptionFetch = fetch): SubscriptionProviderAdapter {
  return {
    provider: "codex",
    async exchangeCode(input: SubscriptionCodeExchangeInput) {
      const body = await postToken(fetchImpl, {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: input.code,
        redirect_uri: input.redirectUri || REDIRECT_URI,
        code_verifier: input.codeVerifier,
      });
      const tokens = tokensFrom(body, Date.now());
      if (!tokens.providerAccountId) throw new Error("codex token has no chatgpt account id");
      return tokens;
    },
    async refresh(refreshToken: string) {
      const response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw await readProviderError(response);
      return tokensFrom(await response.json() as Record<string, unknown>, Date.now());
    },
    async fetchUsage(accessToken: string, providerAccountId: string) {
      const response = await fetchImpl(USAGE_URL, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "chatgpt-account-id": providerAccountId,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw await readProviderError(response);
      return parseCodexUsage(await response.json());
    },
  };
}

export const CODEX_OAUTH = {
  CLIENT_ID,
  REDIRECT_URI,
  SCOPE,
  AUTHORIZE_URL: "https://auth.openai.com/oauth/authorize",
  extraParams: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  } as Record<string, string>,
};
