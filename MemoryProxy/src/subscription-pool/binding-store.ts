/**
 * Session Binding store: which pool account a client session uses, and the round-robin cursor.
 * Both live in ProxyStorage, so they survive a proxy restart. One proxy replica is supported.
 *
 * A binding expires two days after the last request of the session. The expiry is checked on
 * read, because the storage sweeper works on its own schedule. Bindings sit in the `nottl`
 * bucket so the sweeper never removes a live one; expired ones are pruned when sessions are counted.
 */

import { createHash } from "node:crypto";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { assertKeySegment } from "../storage/key-utils.js";

export const BINDING_TTL_MS = 2 * 24 * 3_600_000;

export interface SessionBinding {
  account_id: string;
  created_at: number;
  last_used_at: number;
}

function bindingPrefix(spaceId: string, provider: string): string {
  assertKeySegment("spaceId", spaceId);
  assertKeySegment("provider", provider);
  return `nottl/${spaceId}/pool-binding/${provider}/`;
}

/** The raw session id can hold any character, so the key uses its hash. */
export function sessionBindingKey(spaceId: string, provider: string, sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 32);
  return `${bindingPrefix(spaceId, provider)}${digest}`;
}

function cursorKey(spaceId: string, provider: string): string {
  assertKeySegment("spaceId", spaceId);
  assertKeySegment("provider", provider);
  return `nottl/${spaceId}/pool-cursor/${provider}`;
}

function isExpired(binding: SessionBinding, now: number): boolean {
  return now - binding.last_used_at > BINDING_TTL_MS;
}

function isBinding(value: unknown): value is SessionBinding {
  const v = value as SessionBinding | null;
  return Boolean(v) && typeof v!.account_id === "string" && typeof v!.last_used_at === "number";
}

/** The live binding of a session, or null. An expired binding is deleted. */
export async function getBinding(storage: ProxyStorage, key: string, now: number): Promise<SessionBinding | null> {
  const stored = await storage.getJSON<SessionBinding>(key);
  if (!isBinding(stored)) return null;
  if (isExpired(stored, now)) {
    await storage.del(key);
    return null;
  }
  return stored;
}

/**
 * Bind a session to an account. The first write wins, so two concurrent first requests end up
 * on one account: the loser reads and returns the winner's account.
 */
export async function bindSession(
  storage: ProxyStorage,
  key: string,
  accountId: string,
  now: number,
): Promise<{ accountId: string; created: boolean }> {
  const binding: SessionBinding = { account_id: accountId, created_at: now, last_used_at: now };
  if (await storage.putJSONIfAbsent(key, binding)) return { accountId, created: true };

  const existing = await getBinding(storage, key, now);
  if (existing) return { accountId: existing.account_id, created: false };

  // The stored binding was expired or unreadable and is now deleted. Try once more.
  if (await storage.putJSONIfAbsent(key, binding)) return { accountId, created: true };
  const winner = await getBinding(storage, key, now);
  return { accountId: winner?.account_id ?? accountId, created: false };
}

/** Point the session at an account and refresh its lifetime. */
export async function rebindSession(storage: ProxyStorage, key: string, accountId: string, now: number): Promise<void> {
  const previous = await storage.getJSON<SessionBinding>(key);
  const created_at = isBinding(previous) ? previous.created_at : now;
  await storage.putJSON(key, { account_id: accountId, created_at, last_used_at: now } satisfies SessionBinding);
}

/** Live sessions per account for one instance and provider. Expired bindings are deleted. */
export async function countSessionsByAccount(
  storage: ProxyStorage,
  spaceId: string,
  provider: string,
  now: number,
): Promise<Map<string, number>> {
  const prefix = bindingPrefix(spaceId, provider);
  const counts = new Map<string, number>();
  for (const name of await storage.listNames(prefix)) {
    const stored = await storage.getJSON<SessionBinding>(prefix + name);
    if (!isBinding(stored)) continue;
    if (isExpired(stored, now)) {
      await storage.del(prefix + name);
      continue;
    }
    counts.set(stored.account_id, (counts.get(stored.account_id) ?? 0) + 1);
  }
  return counts;
}

export async function getCursor(storage: ProxyStorage, spaceId: string, provider: string): Promise<number> {
  const stored = await storage.getJSON<{ cursor: number }>(cursorKey(spaceId, provider));
  return stored && Number.isInteger(stored.cursor) && stored.cursor >= 0 ? stored.cursor : 0;
}

export async function setCursor(storage: ProxyStorage, spaceId: string, provider: string, cursor: number): Promise<void> {
  await storage.putJSON(cursorKey(spaceId, provider), { cursor });
}
