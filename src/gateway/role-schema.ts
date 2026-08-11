/**
 * Role config schema (wave tdai-memory-factory-2026-08-03; tz-01 B4).
 *
 * 19 required fields + 2 optional (`runtime`, `retry_budget`) = a 21-key
 * whitelist. Zod-less: one table of per-field predicates, used by both
 * entry points, so "is this value valid" is stated exactly once.
 *
 *   validateRoleConfig  — legacy boolean-ish gate: valid config or null.
 *   inspectRoleConfig   — same rules, but distinguishes WHY a file failed:
 *                         invalid (unknown key / wrong type) vs partial
 *                         (known keys, all well-typed, some missing). tz-01
 *                         needs that split: invalid is fail-closed, partial
 *                         is what the LegacyRoleAdapter is allowed to fill.
 */
import type { ApplyOp } from "./role-paths.js";

/** Strict 21-key role config. Unknown keys → load returns null. */
export interface RoleConfigFile {
  name?: string;
  model?: string;
  prompt_file?: string;
  enabled?: boolean;
  thinking?: string;
  timeout_min?: number;
  scope?: "full_store" | "fresh_tail" | "over_limit_only";
  trigger?: "schedule" | "threshold" | "both" | "manual_only";
  schedule?: string | null;
  threshold?: number | null;
  idsOnly?: boolean;
  diff_cap?: number;
  diff_byte_cap?: number;
  ops_subset?: ReadonlyArray<ApplyOp>;
  tools_subset?: ReadonlyArray<string>;
  caps?: { delete_per_run?: number; rewrite_per_run?: number };
  max_run_ms?: number;
  fail_on_missing_prompt?: boolean;
  critic_role?: string | null;
  /** Retry budget of the role: how many LaunchAttempts a RoleRun may spend
   * before it is terminal (tz-01 B4; tz-09 builds `failed-terminal` on it).
   * Finite by construction — absent means DEFAULT_RETRY_BUDGET, never
   * "retry forever". */
  retry_budget?: number;
  /** Optional per-role spawn wiring (forked task-cycle path б): extension to
   * extension bundle, skill dir, scratch root override — the launcher turns
   * them into host arguments. */
  /** Host capabilities the role cannot work without (tz-06 L5). A host that
   * lacks one is refused as `host-incompatible` — never silently launched
   * with a reduced set of tools. */
  requires_capabilities?: ReadonlyArray<string>;
  runtime?: {
    extension_path?: string;
    skill_path?: string;
    scratch_root?: string;
    /** Keep the attempt dir after the run — retention deletes it, not the
     * runner. Default false: the wipe stays the behaviour nobody opted out of. */
    keep_scratch?: boolean;
  };
}

/** Schema default for `retry_budget` (tz-01 B4: the default lives here, and
 * it is finite). One retry after the first attempt. */
export const DEFAULT_RETRY_BUDGET = 2;

/** Upper bound: a contract asking for more attempts than this is a typo, not
 * a policy — the run would hold the per-role gate for hours. */
export const MAX_RETRY_BUDGET = 20;

export const ROLE_SCOPES = [
  "full_store",
  "fresh_tail",
  "over_limit_only",
] as const;
export const ROLE_TRIGGERS = [
  "schedule",
  "threshold",
  "both",
  "manual_only",
] as const;
/** Per-key types under `runtime`. A key missing from this table is dropped by
 * the whitelist below — silently, which is why `keep_scratch` has to be added
 * HERE and not only where it is consumed (tz-02 критерий 4). */
const RUNTIME_KEY_CHECKS: Record<string, (v: unknown) => boolean> = {
  extension_path: (v) => isStr(v),
  skill_path: (v) => isStr(v),
  scratch_root: (v) => isStr(v),
  keep_scratch: (v) => isBool(v),
};

export function isApplyOp(v: unknown): v is ApplyOp {
  return (
    v === "deleteL1" ||
    v === "merge" ||
    v === "rewriteBlock" ||
    v === "rewriteRecord" ||
    v === "rewritePersona"
  );
}

const isStr = (v: unknown): boolean => typeof v === "string";
const isNum = (v: unknown): boolean => typeof v === "number";
const isBool = (v: unknown): boolean => typeof v === "boolean";
const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Per-field validity, stated once. A field passes or the file is invalid. */
const FIELD_CHECKS: Record<string, (v: unknown) => boolean> = {
  name: isStr,
  model: isStr,
  prompt_file: isStr,
  thinking: isStr,
  enabled: isBool,
  idsOnly: isBool,
  fail_on_missing_prompt: isBool,
  timeout_min: isNum,
  diff_cap: isNum,
  diff_byte_cap: isNum,
  max_run_ms: isNum,
  scope: (v) => ROLE_SCOPES.includes(v as (typeof ROLE_SCOPES)[number]),
  trigger: (v) => ROLE_TRIGGERS.includes(v as (typeof ROLE_TRIGGERS)[number]),
  schedule: (v) => v === null || isStr(v),
  threshold: (v) => v === null || isNum(v),
  critic_role: (v) => v === null || isStr(v),
  ops_subset: (v) => Array.isArray(v) && v.every(isApplyOp),
  tools_subset: (v) => Array.isArray(v) && v.every(isStr),
  requires_capabilities: (v) => Array.isArray(v) && v.every(isStr),
  caps: (v) => isRec(v) && isNum(v.delete_per_run) && isNum(v.rewrite_per_run),
  retry_budget: (v) =>
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 1 &&
    v <= MAX_RETRY_BUDGET,
  runtime: (v) =>
    isRec(v) &&
    Object.entries(v).every(([k, x]) => RUNTIME_KEY_CHECKS[k]?.(x) ?? false),
};

/** The 19 fields a complete contract must carry. */
export const REQUIRED_PRESENT_FIELDS = [
  "name",
  "model",
  "prompt_file",
  "enabled",
  "thinking",
  "timeout_min",
  "scope",
  "trigger",
  "schedule",
  "threshold",
  "idsOnly",
  "diff_cap",
  "diff_byte_cap",
  "ops_subset",
  "tools_subset",
  "caps",
  "max_run_ms",
  "fail_on_missing_prompt",
  "critic_role",
] as const;

/** Whitelist of allowed keys: the 19 required ones plus the optional. */
export const REQUIRED_ROLE_FIELDS = [
  ...REQUIRED_PRESENT_FIELDS,
  "runtime",
  "retry_budget",
  "requires_capabilities",
] as const;

export type RoleConfigInspection =
  | { kind: "valid"; config: RoleConfigFile }
  | { kind: "partial"; config: RoleConfigFile; missing: string[] }
  | { kind: "invalid"; reason: string };

/**
 * Inspect a parsed JSON object against the schema. Unknown key or wrong type
 * → `invalid` with a human reason; every present key well-typed but some of
 * the 19 required ones absent → `partial`; otherwise `valid`.
 */
export function inspectRoleConfig(parsed: unknown): RoleConfigInspection {
  if (!isRec(parsed)) return { kind: "invalid", reason: "not a JSON object" };
  for (const key of Object.keys(parsed)) {
    if (key === "_comment") continue;
    const check = FIELD_CHECKS[key];
    if (!check) return { kind: "invalid", reason: `unknown field "${key}"` };
    if (!check(parsed[key])) {
      return { kind: "invalid", reason: `field "${key}" has an invalid value` };
    }
  }
  const missing = REQUIRED_PRESENT_FIELDS.filter((f) => !(f in parsed));
  const config = parsed as unknown as RoleConfigFile;
  return missing.length === 0
    ? { kind: "valid", config }
    : { kind: "partial", config, missing: [...missing] };
}

/** Validate a parsed JSON object against the strict schema (null on failure). */
export function validateRoleConfig(parsed: unknown): RoleConfigFile | null {
  const res = inspectRoleConfig(parsed);
  return res.kind === "valid" ? res.config : null;
}
