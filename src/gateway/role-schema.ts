/**
 * Role config schema (wave tdai-memory-factory-2026-08-03). Strict 19-field
 * RoleConfigFile + zod-less validator (manual type checks; avoids adding a
 * zod dep for a 19-field shape that's already in a single owner file).
 */
import type { ApplyOp } from "./role-paths.js";

/** Strict 19-field role config. Unknown keys → load returns null. */
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
}

/** 19 required field names for the strict schema. */
export const REQUIRED_ROLE_FIELDS = [
  "name", "model", "prompt_file", "enabled", "thinking", "timeout_min",
  "scope", "trigger", "schedule", "threshold", "idsOnly",
  "diff_cap", "diff_byte_cap", "ops_subset", "tools_subset", "caps",
  "max_run_ms", "fail_on_missing_prompt", "critic_role",
] as const;

export function isApplyOp(v: unknown): v is ApplyOp {
  return v === "deleteL1" || v === "merge" || v === "rewriteBlock" ||
    v === "rewriteRecord" || v === "rewritePersona";
}

/** Validate a parsed JSON object against the strict 19-field schema. */
export function validateRoleConfig(parsed: unknown): RoleConfigFile | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!REQUIRED_ROLE_FIELDS.includes(key as typeof REQUIRED_ROLE_FIELDS[number])) {
      // Unknown key → fail (strict schema). _comment is allowed.
      if (key !== "_comment") return null;
    }
  }
  if (!Array.isArray(obj.ops_subset)) return null;
  for (const op of obj.ops_subset) if (!isApplyOp(op)) return null;
  if (!Array.isArray(obj.tools_subset)) return null;
  for (const t of obj.tools_subset) if (typeof t !== "string") return null;
  if (!obj.caps || typeof obj.caps !== "object") return null;
  const caps = obj.caps as Record<string, unknown>;
  if (typeof caps.delete_per_run !== "number") return null;
  if (typeof caps.rewrite_per_run !== "number") return null;
  if (typeof obj.max_run_ms !== "number") return null;
  if (typeof obj.idsOnly !== "boolean") return null;
  if (typeof obj.timeout_min !== "number") return null;
  if (!["full_store", "fresh_tail", "over_limit_only"].includes(obj.scope as string)) return null;
  if (!["schedule", "threshold", "both", "manual_only"].includes(obj.trigger as string)) return null;
  if (obj.schedule !== null && typeof obj.schedule !== "string") return null;
  if (obj.threshold !== null && typeof obj.threshold !== "number") return null;
  if (typeof obj.fail_on_missing_prompt !== "boolean") return null;
  if (typeof obj.name !== "string") return null;
  if (typeof obj.model !== "string") return null;
  if (typeof obj.prompt_file !== "string") return null;
  if (typeof obj.enabled !== "boolean") return null;
  if (typeof obj.thinking !== "string") return null;
  if (typeof obj.diff_cap !== "number") return null;
  if (typeof obj.diff_byte_cap !== "number") return null;
  if (obj.critic_role !== null && typeof obj.critic_role !== "string") return null;
  return obj as unknown as RoleConfigFile;
}
