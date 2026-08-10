/**
 * Capability matrix (tz-06 L5, criterion 11).
 *
 * A role declares what it cannot work without; a launcher declares what its
 * host can do. A missing REQUIRED capability is a refusal, not a reduced
 * launch: a role that quietly runs without its skill or its critic produces a
 * wrong candidate and nobody notices.
 *
 * The names are the ROLE's vocabulary, not a host's flag names — that is what
 * keeps `no-host-hardcode` true above `launchers/`.
 */
import type { LaunchError } from "./types.js";

/** Everything a role may currently ask for. Adding a name here without
 * teaching some launcher to provide it makes every host incompatible — which
 * is the intended failure, loudly. */
export const KNOWN_CAPABILITIES = [
  /** Per-attempt transcript the operator can read afterwards (Ф3). */
  "session",
  /** Loading the role's own extension bundle (`runtime.extension_path`). */
  "extension",
  /** Loading the role's own skill dir (`runtime.skill_path`). */
  "skill",
  /** A per-request thinking level. */
  "thinking",
  /** Restricting the child to a subset of host tools. */
  "tool-subset",
  /** Running the child under an isolation profile (Ф6). */
  "isolation",
] as const;

export type Capability = (typeof KNOWN_CAPABILITIES)[number];

/**
 * What the binding asks for and the host cannot give — recorded, not refused.
 *
 * `thinking` is the live case: it is a required field of every role.json
 * (role-schema.ts:130) and gets filled from the instance config even when the
 * role never chose it, so refusing on it would make every valid role pi-only.
 * Dropping it silently is the other extreme — the run record would then claim
 * a level nobody applied. This is the middle: the host runs the role, and the
 * log says which part of the binding it ignored.
 *
 * @returns the warning line, or null when nothing was dropped.
 */
export function unusedBinding(
  launcherId: string,
  thinking: string | null | undefined,
  provided: ReadonlySet<string>,
): string | null {
  if (!thinking || provided.has("thinking")) return null;
  return (
    `launcher "${launcherId}" has no per-request thinking level: ` +
    `the role's "${thinking}" is NOT applied to this run`
  );
}

/** Refuse with the FULL list of what is missing — an operator fixing them one
 * error at a time is an operator restarting the gateway five times. */
export function checkCapabilities(
  launcherId: string,
  required: readonly string[],
  provided: ReadonlySet<string>,
): LaunchError | null {
  const missing = required.filter((c) => !provided.has(c));
  if (missing.length === 0) return null;
  return {
    kind: "host-incompatible",
    message:
      `launcher "${launcherId}" lacks required capabilit` +
      `${missing.length === 1 ? "y" : "ies"} [${missing.join(", ")}] ` +
      `(provides [${[...provided].sort().join(", ")}])`,
  };
}
