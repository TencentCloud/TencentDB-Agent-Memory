import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { PluginLogger } from "./types.js";

export type DelegateCompactionToRuntime = (params: any) => Promise<any>;

interface ResolveDelegateOptions {
  baseUrls?: Array<string | URL>;
  moduleRoots?: string[];
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  includeDefaults?: boolean;
}

const SDK_SPECIFIER = "openclaw/plugin-sdk";
let cachedDelegate: DelegateCompactionToRuntime | undefined;

/** Resolve OpenClaw's native compaction bridge without assuming /usr/local. */
export async function resolveOpenClawDelegateCompactionToRuntime(
  logger?: PluginLogger,
  options: ResolveDelegateOptions = {},
): Promise<DelegateCompactionToRuntime | null> {
  const useCache = Object.keys(options).length === 0;
  if (useCache && cachedDelegate) return cachedDelegate;

  const failures: string[] = [];
  for (const baseUrl of buildRequireBases(options)) {
    let requireFromBase: ReturnType<typeof createRequire>;
    try {
      requireFromBase = createRequire(baseUrl);
    } catch (error) {
      failures.push(`${String(baseUrl)}: ${formatResolveError(error)}`);
      continue;
    }
    try {
      const delegate = getDelegate(requireFromBase(SDK_SPECIFIER));
      if (delegate) {
        logger?.debug?.(`[context-offload] compact: resolved ${SDK_SPECIFIER} from ${String(baseUrl)}`);
        if (useCache) cachedDelegate = delegate;
        return delegate;
      }
      failures.push(`${String(baseUrl)}: export missing`);
      continue;
    } catch (error) {
      try {
        // ESM-only plugin SDKs cannot be loaded with require(). Resolve the
        // exported entry with the same base, then load it through import().
        const resolvedPath = requireFromBase.resolve(SDK_SPECIFIER);
        const delegate = getDelegate(await import(pathToFileURL(resolvedPath).href));
        if (delegate) {
          logger?.debug?.(`[context-offload] compact: resolved ESM ${SDK_SPECIFIER} from ${resolvedPath}`);
          if (useCache) cachedDelegate = delegate;
          return delegate;
        }
        failures.push(`${String(baseUrl)}: ESM export missing`);
      } catch (importError) {
        failures.push(`${String(baseUrl)}: ${formatResolveError(importError ?? error)}`);
      }
    }
  }

  logger?.debug?.(
    `[context-offload] compact: ${SDK_SPECIFIER} unavailable after ${failures.length} probe(s): ${failures.join("; ")}`,
  );
  // Do not cache misses: OpenClaw may finish loading its SDK after plugin init.
  return null;
}

export function clearOpenClawDelegateCacheForTests(): void {
  cachedDelegate = undefined;
}

function getDelegate(moduleValue: any): DelegateCompactionToRuntime | null {
  const candidate = moduleValue?.delegateCompactionToRuntime
    ?? moduleValue?.default?.delegateCompactionToRuntime;
  return typeof candidate === "function" ? candidate : null;
}

function buildRequireBases(options: ResolveDelegateOptions): Array<string | URL> {
  const values: Array<string | URL> = [...(options.baseUrls ?? [])];
  if (options.includeDefaults !== false) {
    values.push(import.meta.url, join(options.cwd ?? process.cwd(), "tdai-openclaw-resolver.cjs"));
  }

  for (const root of buildModuleRoots(options)) {
    // A require created beside node_modules searches that module root. The
    // package-local base also supports Node package self-reference exports.
    values.push(
      join(dirname(root), "tdai-openclaw-resolver.cjs"),
      join(root, "openclaw", "package.json"),
    );
  }

  const seen = new Set<string>();
  return values.filter((value) => {
    const key = String(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildModuleRoots(options: ResolveDelegateOptions): string[] {
  const roots = [...(options.moduleRoots ?? [])];
  if (options.includeDefaults === false) return dedupePaths(roots);

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;

  for (const entry of (env.NODE_PATH ?? "").split(delimiter)) {
    if (entry.trim()) roots.push(entry.trim());
  }

  const prefixes = [env.npm_config_prefix, env.PREFIX].filter((value): value is string => !!value);
  if (execPath) {
    const execDir = dirname(resolve(execPath));
    prefixes.push(platform === "win32" ? execDir : resolve(execDir, ".."));
  }

  for (const prefix of prefixes) {
    roots.push(platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules"));
  }

  if (platform === "win32" && env.APPDATA) {
    roots.push(join(env.APPDATA, "npm", "node_modules"));
  } else if (platform !== "win32") {
    roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
  }

  return dedupePaths(roots);
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((value) => {
    const key = resolve(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatResolveError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = typeof (error as NodeJS.ErrnoException).code === "string"
    ? `${(error as NodeJS.ErrnoException).code}: `
    : "";
  return `${code}${error.message}`;
}
