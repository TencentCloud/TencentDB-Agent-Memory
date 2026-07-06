/**
 * Stable prompt injector — runtime capability probe for the OpenClaw host API
 * that places system-prompt additions in a cache-stable position (issue #120).
 *
 * Background: OpenClaw's `composeSystemPromptWithHookContext` appends hook
 * context (our `appendSystemContext`) AFTER the CACHE_BOUNDARY marker, at the
 * tail of the per-turn dynamic region — so even byte-stable persona content is
 * re-billed as fresh tokens every turn on prefix-matching providers
 * (DeepSeek / MiMo). The host also ships
 * `prependSystemPromptAdditionAfterCacheBoundary`, which places additions
 * immediately after the boundary, AHEAD of the dynamic tail — the position
 * intended for per-session-constant content — but never calls it for hook
 * context.
 *
 * `openclaw` is an optional peer dependency that is not installed in this
 * repo (type-only import elsewhere), and the API surface has drifted across
 * host versions, so nothing host-side can be imported or type-checked here.
 * Instead we feature-probe at runtime (same idiom as the api.on /
 * registerContextEngine probe in src/offload/index.ts) across every carrier
 * OpenClaw has historically hung request-scoped helpers on: the hook `event`,
 * the hook `ctx`, the plugin `api`, and `api.runtime`.
 *
 * The candidate list is data-driven so a future host rename is a one-line fix.
 */

export type StablePromptInjector = (content: string) => void;

/** Candidate host API names, in priority order. */
export const STABLE_INJECTION_API_CANDIDATES = [
  "prependSystemPromptAdditionAfterCacheBoundary",
] as const;

export interface ResolvedStablePromptInjector {
  /** Bound invoker — calls the host API with the stable block content. */
  injector: StablePromptInjector;
  /** Which carrier exposed the API ("event" | "ctx" | "api" | "api.runtime"). */
  source: string;
  /** The host API name that matched. */
  apiName: string;
}

/**
 * Probe `event`, `ctx`, `api`, `api.runtime` (in that order — request-scoped
 * carriers win over process-scoped ones) for the first candidate that is a
 * function. Returns a bound injector or undefined. Never throws.
 *
 * The caller must wrap the actual injector INVOCATION in try/catch and fall
 * back to hook-context injection if the host API throws.
 */
export function resolveStablePromptInjector(
  api: unknown,
  event?: unknown,
  ctx?: unknown,
): ResolvedStablePromptInjector | undefined {
  // api.runtime may be a request-scoped getter that throws outside a request
  // context — guard the access so the probe honors its "never throws" contract.
  let runtime: unknown;
  try {
    runtime = (api as { runtime?: unknown } | null | undefined)?.runtime;
  } catch {
    runtime = undefined;
  }

  const carriers: Array<[string, unknown]> = [
    ["event", event],
    ["ctx", ctx],
    ["api", api],
    ["api.runtime", runtime],
  ];

  for (const [source, carrier] of carriers) {
    if (!carrier || (typeof carrier !== "object" && typeof carrier !== "function")) continue;
    for (const apiName of STABLE_INJECTION_API_CANDIDATES) {
      let fn: unknown;
      try {
        fn = (carrier as Record<string, unknown>)[apiName];
      } catch {
        continue; // hostile/request-scoped getter — treat as absent on this carrier
      }
      if (typeof fn === "function") {
        return {
          injector: (content: string) => {
            (fn as (content: string) => void).call(carrier, content);
          },
          source,
          apiName,
        };
      }
    }
  }
  return undefined;
}
