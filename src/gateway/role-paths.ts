/**
 * Role path resolvers (wave tdai-memory-factory-2026-08-03).
 *
 * tz-07 H1: paths hang off the data ROOT the caller passes, not off the host's
 * home dir. The pre-tz-07 location stays READABLE through `legacyReadPath`
 * (H2) — an install whose roles still live there keeps working, while every
 * write goes to the new root.
 *
 * Legacy flat: `<root>/memory-keeper/<name>.{json,md}` (1 release deprecation
 * window). Canonical: `<root>/roles/<name>/{role.json,prompt.md}`.
 */
import path from "node:path";
import { defaultTdaiRoot, legacyReadPath } from "./tdai-root.js";

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

/** Canonical parent dir: `<root>/roles/` (pre-tz-07 location still readable). */
export function resolveRoleDir(root: string = defaultTdaiRoot()): string {
  return legacyReadPath(root, ROLES_PARENT_DIR_NAME);
}

/** Legacy flat dir: `<root>/memory-keeper/`. */
export function resolveLegacyRoleDir(root: string = defaultTdaiRoot()): string {
  return legacyReadPath(root, LEGACY_ROLE_DIR_NAME);
}

/** Per-role dir: `roles/<name>/`. */
export function resolvePerRoleDir(
  roleName: string,
  root: string = defaultTdaiRoot(),
): string {
  return path.join(resolveRoleDir(root), roleName);
}
