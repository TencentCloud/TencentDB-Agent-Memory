import { resolveRoleContract } from "../consolidation/role-contract.js";
import type {
  ResolvedRoleContract,
  RoleLegacyDefaults,
} from "../consolidation/role-contract-types.js";

export type L1RolePairResult =
  | {
      ok: true;
      extractor: ResolvedRoleContract;
      critic: ResolvedRoleContract;
    }
  | { ok: false; reason: string };

export function resolveL1RolePair(input: {
  role: string;
  roleDir: string;
  defaults: RoleLegacyDefaults;
}): L1RolePairResult {
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
  const criticRole = extractor.criticRole;
  if (!criticRole)
    return { ok: false, reason: `role "${input.role}" has no critic_role` };
  const criticResolved = resolveRoleContract(
    criticRole,
    input.roleDir,
    input.defaults,
  );
  if (!criticResolved.ok)
    return { ok: false, reason: `critic unusable: ${criticResolved.reason}` };
  const critic = criticResolved.contract;
  for (const contract of [extractor, critic]) {
    if (!contract.enabled)
      return { ok: false, reason: `role "${contract.role}" is disabled` };
    if (contract.source !== "contract")
      return { ok: false, reason: `role "${contract.role}" is not versioned` };
    if (
      contract.assets.artifactTransport !== "stdout-json" ||
      contract.assets.ambientAccess !== "none"
    ) {
      return {
        ok: false,
        reason: `role "${contract.role}" is not stdout-only/ambient-none`,
      };
    }
  }
  return { ok: true, extractor, critic };
}
