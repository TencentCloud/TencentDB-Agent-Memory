/**
 * Pool account cache: per-instance snapshot from Core `accounts/list`, with the same rules as
 * `instance-upstream-cache.ts`: hard TTL (`instanceUpstream.cacheTtlSec`, default 30 s),
 * stale-on-error, and an empty pool when the first call fails.
 *
 * What the proxy learns between two fetches (a 429, a header reading, a refreshed token) is kept
 * in a local overlay that is merged over each snapshot, so the next selection sees it at once
 * even though the report to Core is batched. Core's data wins only when it is newer.
 */

import type { InstanceUpstreamConfig } from "../types.js";
import { callPoolCore, type PoolCoreConfig } from "./core-client.js";
import type { PoolAccount, PoolQuotaWindow, PoolSnapshot } from "./types.js";

const TAG = "[subscription-pool/account-cache]";
const DEFAULT_TTL_SEC = 30;
const DEFAULT_THRESHOLD_PCT = 95;
const MAX_ENTRIES = 256;

interface Overlay {
  exhaustedUntil: number | null;
  windows: Map<string, PoolQuotaWindow>;
  token: { accessToken: string; expiresAt: number | null } | null;
}

interface CacheEntry {
  snapshot: PoolSnapshot;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const lastGood = new Map<string, PoolSnapshot>();
const overlays = new Map<string, Map<string, Overlay>>();

function ttlMs(cacheConfig?: Partial<InstanceUpstreamConfig>): number {
  const sec = cacheConfig?.cacheTtlSec;
  return typeof sec === "number" && Number.isInteger(sec) && sec > 0 ? sec * 1000 : DEFAULT_TTL_SEC * 1000;
}

function overlayFor(spaceId: string, accountId: string): Overlay {
  let perSpace = overlays.get(spaceId);
  if (!perSpace) {
    perSpace = new Map();
    overlays.set(spaceId, perSpace);
  }
  let overlay = perSpace.get(accountId);
  if (!overlay) {
    overlay = { exhaustedUntil: null, windows: new Map(), token: null };
    perSpace.set(accountId, overlay);
  }
  return overlay;
}

function windowKey(window: Pick<PoolQuotaWindow, "name" | "model_scope">): string {
  return `${window.name}\u0000${window.model_scope ?? ""}`;
}

/** Record that an account is exhausted until `until` (epoch ms). A later `until` is kept. */
export function markAccountExhausted(spaceId: string, accountId: string, until: number): void {
  const overlay = overlayFor(spaceId, accountId);
  overlay.exhaustedUntil = Math.max(overlay.exhaustedUntil ?? 0, until);
}

/** Record window readings seen in a response or a 429. Per window the newest observation wins. */
export function observeAccountWindows(spaceId: string, accountId: string, windows: PoolQuotaWindow[]): void {
  const overlay = overlayFor(spaceId, accountId);
  for (const window of windows) {
    const key = windowKey(window);
    const known = overlay.windows.get(key);
    if (!known || window.observed_at >= known.observed_at) overlay.windows.set(key, window);
  }
}

/** Record a token that the proxy got from the `refresh` endpoint. */
export function replaceAccountToken(spaceId: string, accountId: string, accessToken: string, expiresAt: number | null): void {
  overlayFor(spaceId, accountId).token = { accessToken, expiresAt };
}

function applyOverlay(account: PoolAccount, overlay: Overlay | undefined, now: number): PoolAccount {
  if (!overlay) return account;
  let merged = account;

  if (overlay.exhaustedUntil !== null && overlay.exhaustedUntil > now
    && overlay.exhaustedUntil > (account.exhausted_until ?? 0)) {
    merged = { ...merged, exhausted_until: overlay.exhaustedUntil };
  }

  if (overlay.windows.size > 0) {
    const byKey = new Map<string, PoolQuotaWindow>();
    for (const window of account.usage.windows) byKey.set(windowKey(window), window);
    for (const [key, local] of overlay.windows) {
      const base = byKey.get(key);
      if (!base || local.observed_at > base.observed_at) byKey.set(key, local);
    }
    merged = { ...merged, usage: { windows: [...byKey.values()] } };
  }

  if (overlay.token && overlay.token.accessToken !== account.access_token
    && (overlay.token.expiresAt === null
      || account.token_expires_at === null
      || overlay.token.expiresAt > account.token_expires_at)) {
    merged = { ...merged, access_token: overlay.token.accessToken, token_expires_at: overlay.token.expiresAt };
  }
  return merged;
}

function withOverlays(spaceId: string, snapshot: PoolSnapshot, now: number): PoolSnapshot {
  const perSpace = overlays.get(spaceId);
  if (!perSpace) return snapshot;
  return {
    thresholdPct: snapshot.thresholdPct,
    accounts: snapshot.accounts.map((account) => applyOverlay(account, perSpace.get(account.account_id), now)),
  };
}

function dropOverlaysOfDeletedAccounts(spaceId: string, snapshot: PoolSnapshot): void {
  const perSpace = overlays.get(spaceId);
  if (!perSpace) return;
  const live = new Set(snapshot.accounts.map((a) => a.account_id));
  for (const id of perSpace.keys()) if (!live.has(id)) perSpace.delete(id);
}

async function fetchSnapshot(config: PoolCoreConfig, spaceId: string): Promise<PoolSnapshot> {
  const data = await callPoolCore<{ threshold_pct?: number; accounts?: PoolAccount[] }>(config, spaceId, "accounts/list", {});
  return {
    thresholdPct: typeof data?.threshold_pct === "number" ? data.threshold_pct : DEFAULT_THRESHOLD_PCT,
    accounts: Array.isArray(data?.accounts) ? data.accounts : [],
  };
}

/**
 * Accounts of the enabled pool groups of an instance and the threshold, with local readings
 * merged in. `now` is a parameter so tests can move the clock.
 */
export async function getPoolSnapshot(
  config: PoolCoreConfig,
  spaceId: string,
  cacheConfig?: Partial<InstanceUpstreamConfig>,
  now: number = Date.now(),
): Promise<PoolSnapshot> {
  const cached = cache.get(spaceId);
  if (cached && cached.expiresAt > now) return withOverlays(spaceId, cached.snapshot, now);

  try {
    const fresh = await fetchSnapshot(config, spaceId);
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest) cache.delete(oldest);
    }
    cache.set(spaceId, { snapshot: fresh, expiresAt: now + ttlMs(cacheConfig) });
    lastGood.set(spaceId, fresh);
    dropOverlaysOfDeletedAccounts(spaceId, fresh);
    return withOverlays(spaceId, fresh, now);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown";
    const stale = lastGood.get(spaceId);
    if (stale) {
      console.warn(`${TAG} stale-if-error for spaceId=${spaceId} (reason: ${reason})`);
      return withOverlays(spaceId, stale, now);
    }
    console.warn(`${TAG} fetch failed for spaceId=${spaceId}, no stale fallback: ${reason}`);
    return { thresholdPct: DEFAULT_THRESHOLD_PCT, accounts: [], unavailable: true };
  }
}

/** Clear everything (for testing). */
export function clearAccountCache(): void {
  cache.clear();
  lastGood.clear();
  overlays.clear();
}

/** Put a snapshot in the cache without a Core call (for testing). */
export function __primeAccountCacheForTests(spaceId: string, snapshot: PoolSnapshot, ttl = 60_000): void {
  cache.set(spaceId, { snapshot, expiresAt: Date.now() + ttl });
  lastGood.set(spaceId, snapshot);
}
