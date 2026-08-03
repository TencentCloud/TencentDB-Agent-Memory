/**
 * Role path resolvers (wave tdai-memory-factory-2026-08-03).
 * Legacy: `~/.pi/agent-memory/tdai/memory-keeper/<name>.{json,md}` (1 release
 * deprecation window). Canonical: `~/.pi/agent-memory/tdai/roles/<name>/{role.json,prompt.md}`.
 */
import os from "node:os";
import path from "node:path";

/** Apply op whitelist keys (mirror apply-executor.ts ApplyOp keys). */
export type ApplyOp =
  | "deleteL1"
  | "merge"
  | "rewriteBlock"
  | "rewriteRecord"
  | "rewritePersona";

/** Legacy flat path under `~/.pi/agent-memory/tdai/memory-keeper/`. */
const LEGACY_ROLE_DIR_NAME = "memory-keeper";

/** Backward-compat export (pre-split role-files.ts). */
export const ROLE_DIR_NAME = LEGACY_ROLE_DIR_NAME;

/** Canonical per-role directory under `~/.pi/agent-memory/tdai/roles/<name>/`. */
const ROLES_PARENT_DIR_NAME = "roles";

/** Canonical parent dir: `~/.pi/agent-memory/tdai/roles/`. */
export function resolveRoleDir(home: string = os.homedir()): string {
  return path.join(home, ".pi", "agent-memory", "tdai", ROLES_PARENT_DIR_NAME);
}

/** Legacy flat dir: `~/.pi/agent-memory/tdai/memory-keeper/`. */
export function resolveLegacyRoleDir(home: string = os.homedir()): string {
  return path.join(home, ".pi", "agent-memory", "tdai", LEGACY_ROLE_DIR_NAME);
}

/** Per-role dir: `roles/<name>/`. */
export function resolvePerRoleDir(roleName: string, home: string = os.homedir()): string {
  return path.join(resolveRoleDir(home), roleName);
}
