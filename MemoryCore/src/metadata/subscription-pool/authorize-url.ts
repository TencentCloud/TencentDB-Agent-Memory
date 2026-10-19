import { createHash, randomBytes } from "node:crypto";
import { CLAUDE_OAUTH } from "../../subscription-pool/providers/claude.js";
import { CODEX_OAUTH } from "../../subscription-pool/providers/codex.js";
import type { SubscriptionProvider } from "../types.js";

const OAUTH_PROFILES = {
  claude: CLAUDE_OAUTH,
  codex: CODEX_OAUTH,
} as const;

export const SUBSCRIPTION_OAUTH_TTL_MS = 10 * 60 * 1000;

export interface PendingSubscriptionOAuth {
  provider: SubscriptionProvider;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}

export function createPendingSubscriptionOAuth(
  provider: SubscriptionProvider,
  now = Date.now(),
): PendingSubscriptionOAuth {
  const codeVerifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  return {
    provider,
    state,
    codeVerifier,
    redirectUri: OAUTH_PROFILES[provider].REDIRECT_URI,
    expiresAt: now + SUBSCRIPTION_OAUTH_TTL_MS,
  };
}

/** Authorize URL of the provider's public CLI login. The verifier stays on the server. */
export function subscriptionAuthorizeUrl(pending: PendingSubscriptionOAuth): string {
  const profile = OAUTH_PROFILES[pending.provider];
  const challenge = createHash("sha256").update(pending.codeVerifier).digest("base64url");
  const url = new URL(profile.AUTHORIZE_URL);
  url.searchParams.set("client_id", profile.CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", pending.redirectUri);
  url.searchParams.set("scope", profile.SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pending.state);
  for (const [key, value] of Object.entries(profile.extraParams)) url.searchParams.set(key, value);
  return url.toString();
}

/** Accepts the full redirect URL, `code#state`, or a bare code (the state then comes from the request). */
export function parseSubscriptionOAuthCode(code: string | undefined, redirectUrl: string | undefined): { code: string; pastedState?: string } {
  const raw = (code ?? redirectUrl ?? "").trim();
  if (!raw) return { code: "" };
  if (raw.includes("#") && !raw.startsWith("http")) {
    const [pastedCode, pastedState] = raw.split("#");
    return { code: pastedCode ?? "", pastedState };
  }
  if (raw.startsWith("http")) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { code: "" };
    }
    return { code: url.searchParams.get("code") ?? "", pastedState: url.searchParams.get("state") ?? undefined };
  }
  return { code: raw };
}
