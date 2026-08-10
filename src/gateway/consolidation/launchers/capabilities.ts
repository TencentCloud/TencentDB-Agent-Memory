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
