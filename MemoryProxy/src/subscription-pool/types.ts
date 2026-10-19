/**
 * Types shared by the subscription pool modules. They mirror what Core sends through
 * `/v3/internal/meta/subscription-pool/accounts/list` (the proxy view of an account).
 */

/** One usage limit of an account. Times are epoch milliseconds. */
export interface PoolQuotaWindow {
  name: string;
  /** Model the window applies to. Null or absent means the window is shared by all models. */
  model_scope?: string | null;
  used_pct: number;
  /** Reset time of the window. Null when the provider did not tell it. */
  resets_at: number | null;
  observed_at: number;
  source: string;
}

export type PoolAccountStatus = "active" | "exhausted" | "auth_error" | "disabled";

export interface PoolAccount {
  account_id: string;
  group_id: string;
  provider: "claude" | "codex";
  /** Sent as the Codex `chatgpt-account-id` header together with the bearer token. */
  provider_account_id: string;
  status: PoolAccountStatus;
  enabled: boolean;
  access_token: string;
  /** Epoch milliseconds. */
  token_expires_at: number | null;
  usage: { windows: PoolQuotaWindow[] };
  /** Epoch milliseconds. The account counts as exhausted while `now < exhausted_until`. */
  exhausted_until: number | null;
}

export interface PoolSnapshot {
  thresholdPct: number;
  accounts: PoolAccount[];
  /** True when Core could not be reached and no earlier list exists, so the pool state is unknown. */
  unavailable?: boolean;
}
