import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";

import type { PluginLogger } from "./types.js";

export type DelegateCompactionToRuntime = (params: any) => Promise<any>;

interface ResolveDelegateOptions {
  baseUrls?: Array<string | URL>;
  moduleRoots?: string[];
  includeDefaultRoots?: boolean;
}

const SDK_SPECIFIER = "openclaw/plugin-sdk";

let cachedDelegate: DelegateCompactionToRuntime | null | undefined;

/**
 * Resolve OpenClaw's native compaction bridge from the host installation.
 *
 * Plugins can be installed outside the OpenClaw package, and users commonly run
 * OpenClaw through nvm rather than /usr/local. Probe from the plugin bundle
 * first, then fall back to the active node prefix and standard global roots.
 */
export async function resolveOpenClawDelegateCompactionToRuntime(
  logger?: PluginLogger,
  options: ResolveDelegateOptions = {},
): Promise<DelegateCompactionToRuntime | null> {
  const useCache = !options.baseUrls && !options.moduleRoots;
  if (useCache && cachedDelegate !== undefined) return cachedDelegate;

  for (const baseUrl of buildRequireBaseUrls(options)) {
    try {
      const sdk = createRequire(baseUrl)(SDK_SPECIFIER);
      const delegate = sdk?.delegateCompactionToRuntime;
      if (typeof delegate === "function") {
        logger?.debug?.(`[context-offload] compact: resolved ${SDK_SPECIFIER} via ${String(baseUrl)}`);
        if (useCache) cachedDelegate = delegate;
        return delegate;
      }
    } catch (err) {
      logger?.debug?.(
        `[context-offload] compact: ${SDK_SPECIFIER} resolve failed from ${String(baseUrl)}: ${formatResolveError(err)}`,
      );
    }
  }

  if (useCache) cachedDelegate = null;
  return null;
}

export function clearOpenClawDelegateCacheForTests(): void {
  cachedDelegate = undefined;
}

function buildRequireBaseUrls(options: ResolveDelegateOptions): Array<string | URL> {
  const bases: Array<string | URL> = [];
  const seen = new Set<string>();

  const addBase = (value: string | URL | null | undefined): void => {
    if (!value) return;
    const key = String(value);
    if (seen.has(key)) return;
    seen.add(key);
    bases.push(value);
  };

  for (const baseUrl of options.baseUrls ?? []) addBase(baseUrl);

  addBase(import.meta.url);
  addBase(join(process.cwd(), "openclaw-sdk-resolver.cjs"));

  const moduleRoots = [
    ...(options.includeDefaultRoots === false ? [] : defaultGlobalModuleRoots()),
    ...(options.moduleRoots ?? []),
  ];
  for (const root of moduleRoots) {
    addBase(join(root, "openclaw", "package.json"));
    addBase(join(root, "openclaw"));
    addBase(join(root, "openclaw-sdk-resolver.cjs"));
  }

  return bases;
}

function defaultGlobalModuleRoots(): string[] {
  const roots: string[] = [];

  if (process.env.NODE_PATH) {
    for (const item of process.env.NODE_PATH.split(delimiter)) {
      if (item.trim()) roots.push(item.trim());
    }
  }

  if (process.execPath) {
    roots.push(join(resolve(dirname(process.execPath), ".."), "lib", "node_modules"));
  }

  roots.push("/usr/local/lib/node_modules");
  roots.push("/usr/lib/node_modules");
  return roots;
}

function formatResolveError(err: unknown): string {
  if (err instanceof Error) {
    const code = typeof (err as any).code === "string" ? `${(err as any).code}: ` : "";
    return `${code}${err.message}`;
  }
  return String(err);
}
