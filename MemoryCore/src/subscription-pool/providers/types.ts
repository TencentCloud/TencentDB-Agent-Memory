import type { SubscriptionProvider, SubscriptionQuotaWindow } from "../../metadata/types.js";

export interface ExchangedSubscriptionTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. Null when the provider omitted `expires_in`. */
  expiresAt: number | null;
  providerAccountId: string;
  accountLabel: string;
}

export interface SubscriptionCodeExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  state: string;
}

export class SubscriptionProviderError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = "SubscriptionProviderError";
  }
}

export interface SubscriptionProviderAdapter {
  readonly provider: SubscriptionProvider;
  exchangeCode(input: SubscriptionCodeExchangeInput): Promise<ExchangedSubscriptionTokens>;
  refresh(refreshToken: string): Promise<ExchangedSubscriptionTokens>;
  fetchUsage(accessToken: string, providerAccountId: string): Promise<SubscriptionQuotaWindow[]>;
}

export type SubscriptionFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function parseResetTime(value: unknown, now = Date.now()): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (value.trim() !== "" && Number.isFinite(asNumber)) return parseResetTime(asNumber, now);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Error codes that mean the refresh token is gone and the account needs a new login. */
const PERMANENT_ERROR_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

export async function readProviderError(response: Response): Promise<SubscriptionProviderError> {
  // A 400 alone can be a client bug; only a 401 or a known code means the login is gone.
  let permanent = response.status === 401;
  let message = `provider returned ${response.status}`;
  try {
    const body = await response.json() as { error?: string | { type?: string; code?: string; message?: string } };
    const error = body.error;
    const code = typeof error === "string" ? error : error?.code ?? error?.type;
    if (code && PERMANENT_ERROR_CODES.has(code)) permanent = true;
    message = typeof error === "string" ? error : error?.message || code || message;
  } catch {
    // A non-JSON body still classifies by status.
  }
  if (response.status >= 500 || response.status === 429 || response.status === 408) permanent = false;
  return new SubscriptionProviderError(message, permanent, response.status);
}
