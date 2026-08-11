/**
 * role-files.ts — backward-compat shim. Re-exports from the 3-module split
 * (role-schema, role-paths, role-loader). New code should import from the
 * specific module; this shim exists for callers that still do
 * `import { ... } from "./role-files.js"`.
 */
export type { ApplyOp } from "./role-paths.js";
export {
  ROLE_DIR_NAME,
  resolveRoleDir,
  resolveRoleDirForRead,
  resolveLegacyRoleDir,
  resolvePerRoleDir,
} from "./role-paths.js";
export type { RoleConfigFile } from "./role-schema.js";
export { REQUIRED_ROLE_FIELDS, isApplyOp, validateRoleConfig } from "./role-schema.js";
export {
  loadRoleConfig,
  loadRolePrompt,
  listRoles,
  buildSessionPrompt,
  type RoleListing,
} from "./role-loader.js";
