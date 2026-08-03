/**
 * RoleRuntime — resolved once per run from `RoleConfigFile` + global config.
 * Replaces all `isNight` switches in `executeRun` with config-driven lookups.
 *
 * The orchestrator calls `resolveRoleRuntime(roleName, home)` at the start of
 * every run, then passes the resulting `RoleRuntime` through `runBatch`,
 * `runMultiBatch`, `applyDiff`, `advanceCheckpoint` — every downstream
 * function reads from `runtime` (not from `isNight` boolean).
 */
import {
  loadRoleConfig,
  loadRolePrompt,
  type RoleConfigFile,
  type ApplyOp,
} from "../role-files.js";
import {
  loadRoleConfigFromDir,
  loadRolePromptFromDir,
} from "./role-dir-loader.js";

export type RoleScope = "full_store" | "fresh_tail" | "over_limit_only";
export type RoleTrigger = "schedule" | "threshold" | "both" | "manual_only";

/** Apply contract op whitelist. */
export type OpsSubset = ReadonlySet<ApplyOp>;

export interface RoleRuntime {
  role: string;
  scope: RoleScope;
  trigger: RoleTrigger;
  schedule: string | null;
  threshold: number | null;
  idsOnly: boolean;
  diffCap: number;
  diffByteCap: number;
  opsSubset: OpsSubset;
  toolsSubset: ReadonlySet<string>;
  caps: { deletePerRun: number; rewritePerRun: number };
  maxRunMs: number;
  /** Resolved: config value, with legacy default for memory-keeper. */
  failOnMissingPrompt: boolean;
  criticRole: string | null;
  promptFile: string;
  promptText: string | null;
  timeoutMs: number;
  model: string;
  thinking: string;
  /** Per-role spawn wiring (forked task-cycle path б): optional. */
  runtime: {
    extensionPath: string | null;
    skillPath: string | null;
    scratchRoot: string | null;
  };
}

const DEFAULT_MEMORY_KEEPER = "memory-keeper";

function resolveFailOnMissingPrompt(
  config: RoleConfigFile | null,
  roleName: string,
): boolean {
  if (typeof config?.fail_on_missing_prompt === "boolean") {
    return config.fail_on_missing_prompt;
  }
  // Legacy default: only memory-keeper is fail-open.
  return roleName !== DEFAULT_MEMORY_KEEPER;
}

/**
 * Resolve a `RoleRuntime` from the role's JSON config + role prompt.
 * Returns `null` if the role config is missing/invalid (caller decides
 * fail-loud vs fail-open via `failOnMissingPrompt`).
 */
export function resolveRoleRuntime(
  roleName: string,
  home: string,
): RoleRuntime | null {
  const cfg = loadRoleConfig(roleName, home);
  if (!cfg) return null;
  const prompt = loadRolePrompt(roleName, home);
  return buildRoleRuntime(roleName, cfg, prompt);
}

/** Read the role config from an explicit role directory (canonical
 * `roleDir/<name>/role.json` + bare `roleDir/<name>.json` fallback).
 * Used by day-runner/runner-helpers for per-role spawn wiring (forked
 * task-cycle path б) — resolves against the orchestrator's roleDir so
 * tests can isolate roles without touching os.homedir(). */
export function resolveRoleRuntimeFromDir(
  roleName: string,
  roleDir: string,
): RoleRuntime | null {
  const cfg = loadRoleConfigFromDir(roleName, roleDir);
  if (!cfg) return null;
  const prompt = loadRolePromptFromDir(roleName, roleDir);
  return buildRoleRuntime(roleName, cfg, prompt);
}

function buildRoleRuntime(
  roleName: string,
  cfg: RoleConfigFile,
  prompt: string | null,
): RoleRuntime {
  return {
    role: roleName,
    scope: (cfg.scope ?? "fresh_tail") as RoleScope,
    trigger: (cfg.trigger ?? "manual_only") as RoleTrigger,
    schedule: cfg.schedule ?? null,
    threshold: cfg.threshold ?? null,
    idsOnly: cfg.idsOnly ?? false,
    diffCap: cfg.diff_cap ?? 20,
    diffByteCap: cfg.diff_byte_cap ?? 8192,
    opsSubset: new Set<ApplyOp>(cfg.ops_subset ?? []),
    toolsSubset: new Set<string>(cfg.tools_subset ?? []),
    caps: {
      deletePerRun: cfg.caps?.delete_per_run ?? 0,
      rewritePerRun: cfg.caps?.rewrite_per_run ?? 0,
    },
    maxRunMs: cfg.max_run_ms ?? 1_800_000,
    failOnMissingPrompt: resolveFailOnMissingPrompt(cfg, roleName),
    criticRole: cfg.critic_role ?? null,
    promptFile: cfg.prompt_file ?? `${roleName}.md`,
    promptText: prompt,
    timeoutMs: (cfg.timeout_min ?? 10) * 60_000,
    model: cfg.model ?? "opencode-go/deepseek-v4-flash",
    thinking: cfg.thinking ?? "low",
    runtime: {
      extensionPath: cfg.runtime?.extension_path ?? null,
      skillPath: cfg.runtime?.skill_path ?? null,
      scratchRoot: cfg.runtime?.scratch_root ?? null,
    },
  };
}

/**
 * Default role prompt for legacy memory-keeper when prompt file is missing.
 * Mirrors `orchestrator.ts:DEFAULT_ROLE_PROMPT` (kept here so role-runtime
 * can be used standalone).
 */
export const DEFAULT_MEMORY_KEEPER_PROMPT =
  `Ты — memory-keeper «пчёлка» системы памяти tdai-memory. Твоя задача — консолидация и валидация памяти по секции «Текущий дифф» в системном промте. ` +
  `Только GET-роуты, diff.json как результат, лимиты 1500/2000.`;
