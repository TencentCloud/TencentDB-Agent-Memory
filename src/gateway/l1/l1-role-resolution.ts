import { resolveRoleContract } from "../consolidation/role-contract.js";
import type {
  ResolvedRoleContract,
  RoleLegacyDefaults,
} from "../consolidation/role-contract-types.js";

export type L1RoleResult =
  | { ok: true; extractor: ResolvedRoleContract }
  | { ok: false; reason: string };

export function resolveL1Role(input: {
  role: string;
  roleDir: string;
  defaults: RoleLegacyDefaults;
}): L1RoleResult {
  const resolved = resolveRoleContract(
    input.role,
    input.roleDir,
    input.defaults,
  );
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const extractor = resolved.contract;
  if (!extractor.enabled)
    return { ok: false, reason: `role "${input.role}" is disabled` };
  if (extractor.source !== "contract")
    return { ok: false, reason: `role "${input.role}" is not versioned` };
  if (
    extractor.assets.artifactTransport !== "stdout-json" ||
    extractor.assets.ambientAccess !== "none"
  ) {
    return {
      ok: false,
      reason: `role "${extractor.role}" is not stdout-only/ambient-none`,
    };
  }
  return { ok: true, extractor };
}
