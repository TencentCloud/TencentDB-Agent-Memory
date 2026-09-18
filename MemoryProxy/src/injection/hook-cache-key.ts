import { createHash } from "node:crypto";

import type { InjectionHook } from "./types.js";

type CacheVariantValue = boolean | number | string;

/**
 * Build a deterministic, non-sensitive cache variant from content-producing
 * configuration. Scalar keys are sorted so object insertion order cannot
 * change the fingerprint; the URL/value itself is never put in a storage key.
 */
export function buildHookCacheVariant(
  values: Record<string, CacheVariantValue>,
): string {
  const canonical = Object.keys(values)
    .sort()
    .map((key) => `${key}=${JSON.stringify(values[key])}`)
    .join("\n");
  return `v1-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/**
 * Return the opaque storage id for a hook cache entry. The logical hook id is
 * preserved for registry, observer, and log identity; only persistent cache
 * lookups receive a configuration-sensitive suffix.
 */
export function hookCacheStorageKey(
  hook: Pick<InjectionHook, "id" | "cacheVariant">,
): string {
  const variant = hook.cacheVariant?.trim();
  return variant ? `${hook.id}~${variant}` : hook.id;
}
