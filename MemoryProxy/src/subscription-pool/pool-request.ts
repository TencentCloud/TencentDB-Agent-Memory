/**
 * One client request against a subscription pool: pick an account, run the upstream call,
 * and move to another account when the first one is out of quota.
 *
 *   - The caller supplies `doFetch(auth)` that performs the real upstream call with the headers
 *     of `auth`. All status handling happens before any byte goes to the client, so a retry is safe.
 *   - 429: the account is marked exhausted locally, reported to Core, and the request is retried
 *     once on another account.
 *   - 401: the token is refreshed through Core (`held_expires_at` makes concurrent 401s one
 *     provider refresh) and the request is retried once. If the refresh fails, the account is
 *     skipped and the request moves to another account.
 *   - When no account is left: the client's own login if it sent `x-tdai-user-key`, else a 429
 *     with the earliest reset time.
 *
 * Access tokens are only put into request headers. Logs carry the account id.
 */

import type { ProxyConfig } from "../types.js";
import type { InstanceUpstreamRow } from "../instance-upstream-cache.js";
import { getProxyStorage } from "../storage/factory.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import {
  getPoolSnapshot, markAccountExhausted, observeAccountWindows, replaceAccountToken,
} from "./account-cache.js";
import {
  bindSession, countSessionsByAccount, getBinding, getCursor, rebindSession, sessionBindingKey, setCursor,
  type SessionBinding,
} from "./binding-store.js";
import { callPoolCore, PoolCoreError, type PoolCoreConfig } from "./core-client.js";
import { buildPoolExhaustedResponse, buildPoolUnavailableResponse } from "./exhausted-response.js";
import { parseClaudeLimitBody, parseClaudeQuotaHeaders, parseCodexLimitBody, parseCodexQuotaHeaders } from "./quota-signals.js";
import { reportAccount } from "./reporter.js";
import { earliestReset, selectAccount, type Selection } from "./selector.js";
import type { PoolAccount, PoolSnapshot } from "./types.js";

const TAG = "[subscription-pool]";

export const CODEX_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CLAUDE_API_BASE_URL = "https://api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";

export type PoolProviderId = "claude" | "codex";
/** A 429 without a reset time holds the account for this long. Same default as Core. */
const FALLBACK_EXHAUSTED_MS = 15 * 60 * 1000;
/** After a failed token refresh the account is skipped for this long. */
const REFRESH_FAILURE_COOLDOWN_MS = 60 * 1000;
/** A binding is rewritten at most this often while its session keeps sending requests. */
const BINDING_TOUCH_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export type PoolAuth =
  | { kind: "account"; accountId: string; accessToken: string; providerAccountId: string }
  | { kind: "client" };

export interface PoolRequestInput {
  config: ProxyConfig;
  spaceId: string;
  /** The pool group row. A non-empty `base_url` replaces the provider backend URL. */
  row: InstanceUpstreamRow;
  /** Which pool this request belongs to. Defaults to Codex. */
  provider?: PoolProviderId;
  /** Headers of the client request, as received. */
  clientHeaders: Headers;
  body: Record<string, unknown> | null;
  /** Value of the user key (header `x-tdai-user-key`, else the bearer token). */
  userKey: string;
  /** True for a dialogue turn: it may create or move the Session Binding. False reads only. */
  bindSession: boolean;
  now?: () => number;
}

export interface PoolRequest {
  /** Base URL to join with the request path. */
  readonly upstreamBase: string;
  readonly provider: PoolProviderId;
  /** Account that served the request. Null before the call, or when the client's login was used. */
  readonly accountId: string | null;
  send(doFetch: (auth: PoolAuth) => Promise<Response>): Promise<Response>;
}

/**
 * Session id of a Codex request. A subagent request carries its parent's id so it shares the
 * parent's account; otherwise `session-id`, `session_id`, then `client_metadata.session_id`.
 */
export function extractPoolSessionId(headers: Headers, body: Record<string, unknown> | null): string | null {
  const parent = headers.get("x-parent-conversation-id");
  if (parent) return parent;
  const fromHeader = headers.get("session-id") || headers.get("session_id") || headers.get("x-claude-code-session-id");
  if (fromHeader) return fromHeader;
  const meta = body?.client_metadata as { session_id?: unknown } | undefined;
  return typeof meta?.session_id === "string" && meta.session_id ? meta.session_id : null;
}

/** Headers for one attempt: the base headers with the credentials of `auth` applied. */
function withOAuthBeta(existing: string | undefined): string {
  const parts = (existing ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.includes(OAUTH_BETA)) parts.push(OAUTH_BETA);
  return parts.join(",");
}

export function applyPoolAuth(
  base: Record<string, string>,
  clientHeaders: Headers,
  auth: PoolAuth,
  provider: PoolProviderId = "codex",
): Record<string, string> {
  const headers = { ...base };
  delete headers["authorization"];
  delete headers["x-api-key"];
  delete headers["chatgpt-account-id"];
  if (auth.kind === "account") {
    headers["authorization"] = `Bearer ${auth.accessToken}`;
    if (provider === "codex") headers["chatgpt-account-id"] = auth.providerAccountId;
    if (provider === "claude") headers["anthropic-beta"] = withOAuthBeta(headers["anthropic-beta"]);
    return headers;
  }
  const authorization = clientHeaders.get("authorization");
  const chatgptAccountId = clientHeaders.get("chatgpt-account-id");
  if (authorization) headers["authorization"] = authorization;
  if (provider === "codex" && chatgptAccountId) headers["chatgpt-account-id"] = chatgptAccountId;
  if (provider === "claude") {
    const beta = clientHeaders.get("anthropic-beta");
    if (beta) headers["anthropic-beta"] = beta;
  }
  return headers;
}

function coreConfig(config: ProxyConfig): PoolCoreConfig {
  return config.coreSkill;
}

class PoolRequestImpl implements PoolRequest {
  accountId: string | null = null;
  readonly upstreamBase: string;
  readonly provider: PoolProviderId;
  private readonly now: () => number;
  private readonly model: string;
  private readonly clientLoginAllowed: boolean;
  private readonly sessionKey: string | null;
  private storage: ProxyStorage | null = null;

  constructor(private readonly input: PoolRequestInput) {
    this.now = input.now ?? Date.now;
    this.provider = input.provider ?? "codex";
    this.upstreamBase = input.row.base_url || (this.provider === "claude" ? CLAUDE_API_BASE_URL : CODEX_CHATGPT_BASE_URL);
    this.model = typeof input.body?.model === "string" ? input.body.model : "";
    // The client's own login is used only when the user key came in its own header and the
    // bearer is something else; otherwise the bearer is the proxy user key and must not go upstream.
    const userKeyHeader = input.clientHeaders.get("x-tdai-user-key")?.trim() ?? "";
    const bearer = (input.clientHeaders.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    this.clientLoginAllowed = Boolean(userKeyHeader) && Boolean(bearer) && bearer !== userKeyHeader
      && bearer !== (input.userKey ?? "");
    const sessionId = extractPoolSessionId(input.clientHeaders, input.body);
    this.sessionKey = sessionId ? `session:${sessionId}` : input.userKey ? `user:${input.userKey}` : null;
    try {
      this.storage = getProxyStorage(input.config.storage);
    } catch (err) {
      console.warn(`${TAG} storage unavailable, bindings are off: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  async send(doFetch: (auth: PoolAuth) => Promise<Response>): Promise<Response> {
    const excluded = new Set<string>();
    let switches = 0;
    let refreshes = 0;
    let pinned: PoolAccount | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let account = pinned;
      pinned = null;
      let snapshot: PoolSnapshot | null = null;
      if (!account) {
        snapshot = await this.snapshot();
        account = await this.pick(snapshot, excluded);
      }
      if (!account) return this.noAccountLeft(snapshot ?? await this.snapshot(), doFetch);

      const auth: PoolAuth = {
        kind: "account", accountId: account.account_id,
        accessToken: account.access_token, providerAccountId: account.provider_account_id,
      };
      this.accountId = account.account_id;
      const resp = await doFetch(auth);

      if (resp.status === 429) {
        const text = await resp.text();
        this.onLimitReached(account, text, resp.headers);
        excluded.add(account.account_id);
        if (switches++ >= 1) break;
        continue;
      }

      if (resp.status === 401) {
        const text = await resp.text();
        if (refreshes++ === 0) {
          const refreshed = await this.refreshToken(account);
          if (refreshed) {
            pinned = refreshed;
            continue;
          }
          excluded.add(account.account_id);
          if (switches++ >= 1) break;
          continue;
        }
        return new Response(text, { status: resp.status, headers: resp.headers });
      }

      if (resp.status < 400) this.onSuccess(account, resp.headers);
      return resp;
    }

    // Out of attempts after a limit: the client's login, or the 429 with the earliest reset.
    return this.noAccountLeft(await this.snapshot(), doFetch);
  }

  // ── selection ────────────────────────────────────────────────────────────

  private async snapshot(): Promise<PoolSnapshot> {
    const snapshot = await getPoolSnapshot(coreConfig(this.input.config), this.input.spaceId, this.input.config.instanceUpstream, this.now());
    return {
      ...snapshot,
      // Core may return accounts for more than one pool group. This request is tied to one
      // group row, so never send another group's or provider's token to ChatGPT.
      accounts: snapshot.accounts.filter((account) => account.group_id === this.input.row.group_id && account.provider === this.provider),
    };
  }

  private bindingKey(): string | null {
    if (!this.storage || !this.sessionKey) return null;
    try {
      return sessionBindingKey(this.input.spaceId, this.provider, this.sessionKey);
    } catch (err) {
      console.warn(`${TAG} no binding for this request: ${err instanceof Error ? err.message : "unknown"}`);
      return null;
    }
  }

  private async pick(snapshot: PoolSnapshot, excluded: Set<string>): Promise<PoolAccount | null> {
    const now = this.now();
    const key = this.bindingKey();
    const storage = this.storage;
    let binding: SessionBinding | null = null;
    let cursor = 0;
    if (storage) {
      try {
        if (key) binding = await getBinding(storage, key, now);
        cursor = await getCursor(storage, this.input.spaceId, this.provider);
      } catch (err) {
        console.warn(`${TAG} binding read failed: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }

    const selection = selectAccount(snapshot.accounts, binding?.account_id ?? null, now, snapshot.thresholdPct, this.model, cursor, excluded);
    if (!selection) return null;
    if (this.input.bindSession && storage && key) {
      await this.persist(storage, key, selection, binding, snapshot, now);
    }
    return selection.account;
  }

  /** Write the binding and cursor a main-turn selection implies, then refresh session counts. */
  private async persist(
    storage: ProxyStorage,
    key: string,
    selection: Selection,
    binding: SessionBinding | null,
    snapshot: PoolSnapshot,
    now: number,
  ): Promise<void> {
    const accountId = selection.account.account_id;
    try {
      if (selection.kind === "bound") {
        if (binding && now - binding.last_used_at > BINDING_TOUCH_MS) await rebindSession(storage, key, accountId, now);
        return;
      }
      if (selection.kind === "round_robin") await setCursor(storage, this.input.spaceId, this.provider, selection.nextCursor);

      let changed = false;
      if (binding) {
        await rebindSession(storage, key, accountId, now);
        changed = true;
      } else {
        const bound = await bindSession(storage, key, accountId, now);
        changed = bound.created;
        if (!bound.created && bound.accountId !== accountId) {
          // A concurrent first request bound this session already; the bound account is the one in use.
          const winner = snapshot.accounts.find((a) => a.account_id === bound.accountId);
          if (winner) selection.account = winner;
        }
      }
      if (changed) {
        this.reportSessionCounts(storage, [accountId, binding?.account_id], now);
      }
    } catch (err) {
      console.warn(`${TAG} binding write failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  /** Tell Core how many sessions the accounts have now. Runs in the background. */
  private reportSessionCounts(storage: ProxyStorage, accountIds: Array<string | undefined>, now: number): void {
    const ids = [...new Set(accountIds.filter((id): id is string => Boolean(id)))];
    void countSessionsByAccount(storage, this.input.spaceId, this.provider, now)
      .then((counts) => {
        for (const id of ids) {
          reportAccount(coreConfig(this.input.config), this.input.spaceId, id, { active_sessions: counts.get(id) ?? 0 });
        }
      })
      .catch((err: unknown) => {
        console.warn(`${TAG} session count failed: ${err instanceof Error ? err.message : "unknown"}`);
      });
  }

  // ── outcomes ─────────────────────────────────────────────────────────────

  private onSuccess(account: PoolAccount, headers: Headers): void {
    const windows = this.provider === "claude"
      ? parseClaudeQuotaHeaders(headers, this.now())
      : parseCodexQuotaHeaders(headers, this.now());
    if (windows.length === 0) return;
    observeAccountWindows(this.input.spaceId, account.account_id, windows);
    reportAccount(coreConfig(this.input.config), this.input.spaceId, account.account_id, { windows });
  }

  private onLimitReached(account: PoolAccount, bodyText: string, headers: Headers): void {
    const now = this.now();
    const info = this.provider === "claude"
      ? parseClaudeLimitBody(headers, now)
      : parseCodexLimitBody(bodyText, headers, now);
    markAccountExhausted(this.input.spaceId, account.account_id, info.resetsAt ?? now + FALLBACK_EXHAUSTED_MS);
    const windows = this.provider === "claude"
      ? parseClaudeQuotaHeaders(headers, now)
      : parseCodexQuotaHeaders(headers, now);
    if (windows.length > 0) observeAccountWindows(this.input.spaceId, account.account_id, windows);
    reportAccount(coreConfig(this.input.config), this.input.spaceId, account.account_id, {
      status_code: 429,
      ...(info.retryAfterSec !== null ? { retry_after: info.retryAfterSec } : {}),
      ...(windows.length > 0 ? { windows } : {}),
    });
    console.warn(`${TAG} account_id=${account.account_id} hit its usage limit`);
  }

  /** Returns the account with a fresh token, or null when Core could not refresh it. */
  private async refreshToken(account: PoolAccount): Promise<PoolAccount | null> {
    reportAccount(coreConfig(this.input.config), this.input.spaceId, account.account_id, { status_code: 401 });
    try {
      const result = await callPoolCore<{ access_token: string; provider_account_id?: string; token_expires_at: number | null }>(
        coreConfig(this.input.config), this.input.spaceId, "refresh",
        { account_id: account.account_id, held_expires_at: account.token_expires_at },
      );
      replaceAccountToken(this.input.spaceId, account.account_id, result.access_token, result.token_expires_at);
      return {
        ...account,
        access_token: result.access_token,
        token_expires_at: result.token_expires_at,
        provider_account_id: result.provider_account_id || account.provider_account_id,
      };
    } catch (err) {
      const reason = err instanceof PoolCoreError ? `${err.httpStatus} ${err.errorCode ?? ""}`.trim() : "unreachable";
      console.warn(`${TAG} token refresh failed for account_id=${account.account_id} (${reason})`);
      markAccountExhausted(this.input.spaceId, account.account_id, this.now() + REFRESH_FAILURE_COOLDOWN_MS);
      return null;
    }
  }

  private async noAccountLeft(snapshot: PoolSnapshot, doFetch: (auth: PoolAuth) => Promise<Response>): Promise<Response> {
    if (this.clientLoginAllowed) {
      this.accountId = null;
      return doFetch({ kind: "client" });
    }
    if (snapshot.unavailable) return buildPoolUnavailableResponse();
    const now = this.now();
    return buildPoolExhaustedResponse(earliestReset(snapshot.accounts, now, snapshot.thresholdPct, this.model), now);
  }
}

export function openPoolRequest(input: PoolRequestInput): PoolRequest {
  return new PoolRequestImpl(input);
}
