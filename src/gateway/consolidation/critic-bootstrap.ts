/**
 * Critic bootstrap (tz-09 Ф4a, P11 + criterion 6).
 *
 * A critic is a ROLE, not a prompt: it needs a package (role.json + prompt),
 * a contract that passes the schema, and a binding this launcher can run.
 * A bare `prompt.md` — which is all `dedup-daily-critic` has on disk today —
 * is not a critic.
 *
 * The check runs BEFORE the main role is launched, so an unusable critic
 * costs nothing: in `enforce` the role is disabled with the reason, in
 * `shadow` the reason is logged and the run proceeds (the gates ship dark,
 * tz-09 R1).
 */
import { resolveRoleContract } from "./role-contract.js";
import type { OrchestratorContext } from "./context.js";
import type { ResolvedRoleContract } from "./role-contract-types.js";

export type CriticBootstrap =
  { ok: true; contract: ResolvedRoleContract } | { ok: false; reason: string };

/** Launchers this build can actually run. tz-06 widens it. */
const SUPPORTED_LAUNCHERS = new Set(["pi"]);

export function resolveCriticPackage(
  ctx: OrchestratorContext,
  role: ResolvedRoleContract,
): CriticBootstrap {
  const criticRole = role.criticRole;
  if (criticRole === null || criticRole === undefined || criticRole === "") {
    return { ok: false, reason: `role "${role.role}" declares no critic_role` };
  }

  const resolution = resolveRoleContract(
    criticRole,
    ctx.roleDir,
    ctx.roleDefaults,
  );
  if (!resolution.ok) {
    // Covers "no package at all" and "role.json does not pass the schema":
    // the tz-01 resolver is already fail-closed and carries the reason.
    return {
      ok: false,
      reason: `critic "${criticRole}" unusable: ${resolution.reason}`,
    };
  }
  const critic = resolution.contract;
  // P11, literally: "Prompt без manifest/contract не считается ролью". The
  // tz-01 resolver is deliberately forgiving — a bare prompt.md resolves as
  // `legacy-absent` with every value invented by the LegacyRoleAdapter. That
  // is fine for a keeper the operator has run for months; it is NOT a critic,
  // because a gate whose policy was guessed guards nothing.
  if (critic.source !== "contract") {
    return {
      ok: false,
      reason:
        `critic "${criticRole}" has no versioned package ` +
        `(resolved as ${critic.source}: ${critic.warnings[0] ?? "no role.json"})`,
    };
  }
  if (!critic.enabled) {
    return { ok: false, reason: `critic "${criticRole}" is disabled` };
  }
  if (!SUPPORTED_LAUNCHERS.has(critic.binding.launcherId)) {
    return {
      ok: false,
      reason:
        `critic "${criticRole}" binding is host-incompatible ` +
        `(launcher "${critic.binding.launcherId}")`,
    };
  }
  if ((critic.prompt.text ?? "").trim() === "") {
    return { ok: false, reason: `critic "${criticRole}" has an empty prompt` };
  }
  return { ok: true, contract: critic };
}
