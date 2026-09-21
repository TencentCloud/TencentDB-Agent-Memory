/**
 * ensure-hook-policy.ts
 *
 * Auto-patches openclaw.json to add `hooks.allowConversationAccess: true`
 * for our plugin. Without it, the gateway silently blocks agent_end hooks
 * for non-bundled plugins (v2026.4.23+, PR #70786).
 */

import fs from "node:fs";
import path from "node:path";
import { getEnv } from "./env.js";
import JSON5 from "json5";

const PLUGIN_ID = "memory-tencentdb";

/**
 * Hook auto-patch scheduling (openclaw 9.5 gateway-ized install compat).
 *
 * openclaw 9.5 executes `plugins install` inside the gateway process, so the
 * plugin's register runs while install is still about to write `enabled` to the
 * config. Patching hooks there is unsafe for two reasons:
 *   1. Synchronous write races install's own config write (optimistic locking
 *      on the config hash) → "config changed since last load".
 *   2. `mutateConfigFile` is bound to the plugin's temporary runtime (a
 *      `runWithPluginScope` guard), which install's kind-inspection releases
 *      right after register. Any deferred call then throws
 *      "Plugin runtime is no longer active".
 *
 * For 9.5+ hosts we therefore defer the patch and write the file directly via
 * `manualPatch` (which only uses `fs`, never the runtime-bound SDK). Older hosts
 * (8.2/9.4) never had the gateway-ized install race, so they keep the original
 * immediate + restart behavior for zero behavior change.
 */
const GATEWAYIZED_INSTALL_MIN: [number, number, number] = [2026, 9, 5];
const MANUAL_PATCH_DELAY_MS = 60000;

/**
 * Minimum host version at which `hooks.allowConversationAccess` is both
 * recognised by the schema and enforced. See header comment.
 */
export const HOOK_POLICY_MIN_VERSION: readonly [number, number, number] = [
  2026, 4, 24,
];

/**
 * Parse the leading `x.y.z` numeric prefix from a version string.
 *
 * Accepts:
 *   "2026.4.24"          -> [2026, 4, 24]
 *   "2026.4.24-beta.1"   -> [2026, 4, 24]
 *   "2026.5.3-1"         -> [2026, 5,  3]
 *   "2026.4.24.4"        -> [2026, 4, 24]   (extra segments ignored)
 *
 * Rejects (returns null):
 *   - Non-string values  (undefined / null / number / etc.)
 *   - "unknown" / ""     (no clean numeric prefix)
 *   - "2026.4"           (must have all three segments)
 *   - "v2026.4.24"       (no leading non-digit allowed — keep strict)
 */
export function parseVersionXYZ(v: unknown): [number, number, number] | null {
  if (typeof v !== "string") {
    return null;
  }
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.].*)?$/);
  if (!m) {
    return null;
  }
  const [, a, b, c] = m;
  return [Number(a), Number(b), Number(c)];
}

/**
 * Compare two `[x, y, z]` tuples. Returns negative / 0 / positive like a
 * standard comparator (a - b).
 */
export function compareVersionXYZ(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Structured outcome of the hook-policy version gate.
 *
 * Exposed so callers (e.g. index.ts) can log exactly what was compared
 * (`original` raw input, parsed `x.y.z`, and the `min` threshold) without
 * having to re-implement the parse step themselves.
 */
export interface HookPolicyDecision {
  /** Whether the auto-patch should be applied. */
  apply: boolean;
  /** The raw value passed in (useful for logging verbatim). */
  rawVersion: unknown;
  /** Parsed `[x, y, z]`, or `null` if the input was unparsable. */
  parsedXYZ: [number, number, number] | null;
  /** The minimum version threshold the decision was made against. */
  minXYZ: readonly [number, number, number];
}

/**
 * Decide whether we should apply the `allowConversationAccess` auto-patch
 * for the given host version, returning a structured result that callers
 * can log verbatim.
 *
 * Policy:
 *   - Extract the leading `x.y.z` prefix from `rawVersion` (ignoring any
 *     pre-release suffix like `-beta.N`, `-1`, `-alpha.N`, etc.).
 *   - If the prefix is >= {@link HOOK_POLICY_MIN_VERSION}, `apply = true`.
 *   - If the prefix cannot be parsed (unknown / empty / non-string /
 *     undefined — typical on hosts that don't expose `api.runtime.version`),
 *     `apply = false`.  This is the safe default: old hosts don't have the
 *     gate and don't need patching.
 *
 * NOTE: Very early pre-releases of the MIN version itself (e.g.
 * `2026.4.24-beta.1`) will satisfy the predicate. This is intentional —
 * the field was already recognised in those builds and the usage base is
 * negligible.
 */
export function decideHookPolicy(rawVersion: unknown): HookPolicyDecision {
  const parsedXYZ = parseVersionXYZ(rawVersion);
  const apply =
    parsedXYZ !== null &&
    compareVersionXYZ(parsedXYZ, HOOK_POLICY_MIN_VERSION) >= 0;
  return {
    apply,
    rawVersion,
    parsedXYZ,
    minXYZ: HOOK_POLICY_MIN_VERSION,
  };
}

/**
 * Thin boolean wrapper around {@link decideHookPolicy} for callers that
 * only need the yes/no answer.
 */
export function shouldApplyHookPolicy(rawVersion: unknown): boolean {
  return decideHookPolicy(rawVersion).apply;
}

/**
 * Whether the host runs openclaw's gateway-ized plugin install (>= 2026.9.5).
 *
 * Only these hosts execute `plugins install` inside the gateway process, which
 * is what makes the register-time hook patch unsafe (config-write race +
 * `afterWrite: restart` self-kill). Older hosts keep the original synchronous
 * patch path.
 */
export function isGatewayizedInstall(rawVersion: unknown): boolean {
  const parsedXYZ = parseVersionXYZ(rawVersion);
  return parsedXYZ !== null && compareVersionXYZ(parsedXYZ, GATEWAYIZED_INSTALL_MIN) >= 0;
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function isGatewayStart(): boolean {
  const args = process.argv.map((v) => String(v || "").toLowerCase());
  const idx = args.findIndex((a) =>
    a.endsWith("openclaw") || a.endsWith("openclaw.mjs") || a.endsWith("entry.js"),
  );
  if (idx < 0) return true;
  const cmd = args.slice(idx + 1).filter((a) => !a.startsWith("-"))[0];
  if (!cmd) return true;
  const skip = ["plugins", "plugin", "install", "uninstall", "update", "doctor", "security", "config", "onboard", "setup", "status", "version", "help"];
  return !skip.includes(cmd);
}

function resolveConfigPath(): string | null {
  // 1. OPENCLAW_CONFIG_PATH env override (same as core uses)
  const envPath = getEnv("OPENCLAW_CONFIG_PATH")?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;

  // 2. OPENCLAW_STATE_DIR override
  const stateDir = getEnv("OPENCLAW_STATE_DIR")?.trim();
  if (stateDir) {
    const p = path.join(stateDir, "openclaw.json");
    if (fs.existsSync(p)) return p;
  }

  // 3. Standard location: ~/.openclaw/openclaw.json
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "";
  if (!home) return null;
  const p = path.join(home, ".openclaw", "openclaw.json");
  return fs.existsSync(p) ? p : null;
}

function hasPolicyAlready(root: unknown): boolean {
  if (!isObj(root)) return false;
  const entry = (root as any)?.plugins?.entries?.[PLUGIN_ID];
  return isObj(entry) && isObj(entry.hooks) && entry.hooks.allowConversationAccess === true;
}

/**
 * Schedule the manual file patch with a long delay (9.5+ gateway-ized install).
 *
 * Uses `manualPatch` (direct fs read/write, not the runtime-bound SDK) so the
 * deferred call works even after install's kind-inspection releases the plugin
 * runtime. The delay gives install time to finish writing `enabled` first.
 */
function scheduleManualPatch(params: {
  logger: Logger;
}): void {
  const { logger } = params;
  const TAG = "[memory-tdai] [hook-policy]";

  logger.info(
    `${TAG} Missing allowConversationAccess, scheduling manual patch (delay=${MANUAL_PATCH_DELAY_MS}ms)`,
  );
  setTimeout(() => {
    manualPatch(logger);
  }, MANUAL_PATCH_DELAY_MS);
}

/**
 * Original synchronous patch path for hosts without gateway-ized install.
 *
 * Writes hooks immediately and requests a gateway restart so the change takes
 * effect right away. This is safe on 8.2/9.4 because their `plugins install`
 * runs in the CLI process (`isGatewayStart()` is false there), so this path only
 * ever runs during a real gateway startup.
 */
function patchImmediatelyWithRestart(params: {
  runtimeConfig?: { mutateConfigFile?: (p: any) => Promise<any> };
  logger: Logger;
}): void {
  const { logger } = params;
  const TAG = "[memory-tdai] [hook-policy]";
  const mutateConfigFile = params.runtimeConfig?.mutateConfigFile;

  logger.info(`${TAG} Missing allowConversationAccess, patching via SDK...`);
  mutateConfigFile?.({
    afterWrite: { mode: "restart", reason: "memory-tencentdb hook policy auto-patch" },
    mutate: (draft: any) => {
      if (!draft.plugins) draft.plugins = {};
      if (!draft.plugins.entries) draft.plugins.entries = {};
      if (!draft.plugins.entries[PLUGIN_ID]) draft.plugins.entries[PLUGIN_ID] = {};
      if (!draft.plugins.entries[PLUGIN_ID].hooks) draft.plugins.entries[PLUGIN_ID].hooks = {};
      draft.plugins.entries[PLUGIN_ID].hooks.allowConversationAccess = true;
    },
  }).then(() => {
    logger.info(`${TAG} ✅ Patched via SDK — gateway will restart automatically.`);
  }).catch((err: unknown) => {
    logger.warn(
      `${TAG} SDK mutateConfigFile failed: ${err instanceof Error ? err.message : String(err)}, trying manual fallback...`,
    );
    manualPatch(logger);
  });
}

/**
 * Call early in register(). Patches config if missing, triggers restart.
 *
 * Strategy:
 * 1. Try SDK mutateConfigFile (handles path resolution, $include, atomic write,
 *    and triggers gateway restart via afterWrite).
 * 2. Fallback to manual file write if SDK is unavailable or fails.
 */
export function ensurePluginHookPolicy(params: {
  rootConfig?: unknown;
  runtimeConfig?: {
    mutateConfigFile?: (p: any) => Promise<any>;
  };
  hostVersion?: unknown;
  logger: Logger;
}): void {
  const { logger } = params;

  if (!isGatewayStart()) return;
  if (hasPolicyAlready(params.rootConfig)) return;

  if (isGatewayizedInstall(params.hostVersion)) {
    // 9.5+ gateway-ized install: defer + direct file write. `manualPatch` uses
    // only fs (not the runtime-bound SDK), so it survives install's temporary
    // runtime teardown.
    scheduleManualPatch({ logger });
    return;
  }

  if (params.runtimeConfig?.mutateConfigFile) {
    // Older hosts (8.2/9.4): original immediate + restart behavior.
    patchImmediatelyWithRestart({
      runtimeConfig: params.runtimeConfig,
      logger,
    });
    return;
  }

  // Fallback: manual file write (very old hosts without the SDK)
  manualPatch(logger);
}

function manualPatch(logger: Logger): void {
  const TAG = "[memory-tdai] [hook-policy]";

  const configPath = resolveConfigPath();
  if (!configPath) {
    logger.warn(`${TAG} Cannot locate openclaw.json — please add hooks.allowConversationAccess manually`);
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    parsed = JSON5.parse(raw);
  } catch {
    logger.warn(`${TAG} Failed to parse ${configPath} — please add hooks.allowConversationAccess manually`);
    return;
  }

  if (hasPolicyAlready(parsed)) return;

  if ("$include" in parsed || (isObj(parsed.plugins) && "$include" in parsed.plugins)) {
    logger.warn(`${TAG} Config uses $include — please add manually: plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess = true`);
    return;
  }

  if (!isObj(parsed.plugins)) parsed.plugins = {};
  const plugins = parsed.plugins as Record<string, unknown>;
  if (!isObj(plugins.entries)) plugins.entries = {};
  const entries = plugins.entries as Record<string, unknown>;
  if (!isObj(entries[PLUGIN_ID])) entries[PLUGIN_ID] = {};
  const entry = entries[PLUGIN_ID] as Record<string, unknown>;
  if (!isObj(entry.hooks)) entry.hooks = {};
  (entry.hooks as Record<string, unknown>).allowConversationAccess = true;

  try {
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n");
    logger.info(`${TAG} ✅ Auto-added hooks.allowConversationAccess to ${configPath}`);
    logger.warn(`${TAG} ⚠️  Gateway restart required. Run: openclaw gateway restart`);
  } catch (err) {
    logger.warn(`${TAG} Failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}. Add manually.`);
  }
}
