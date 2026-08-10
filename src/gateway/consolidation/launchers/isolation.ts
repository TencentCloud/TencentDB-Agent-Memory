/**
 * Isolation gate L6 (tz-06 Ф6) — security, Tier-2.
 *
 * Two separate things live here, and conflating them is how a gate becomes a
 * formality:
 *
 *   1. the MECHANISM — `bwrap`, a mount+network namespace: the child sees a
 *      read-only system, its own scratch, its own /tmp, and no network;
 *   2. the POLICY — whether a role is ALLOWED to run confined yet. That is
 *      `L6_SIGNED_OFF`, and it is false: the spec (§Risk tier) requires a
 *      separate security review before executable roles are enabled.
 *
 * Until the policy flips, a role that asks for isolation is refused with a
 * typed `isolation-unavailable` — never launched unconfined "for now". The
 * mechanism is implemented and tested anyway, so the review has something
 * concrete to review instead of a promise.
 */
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { ResolvedRoleContract } from "../role-contract-types.js";
import type { LaunchError } from "./types.js";

/**
 * L6 exit criterion. Flipping this to `true` is a SECURITY decision that the
 * tz-06 spec routes through a separate review — it is not a config value and
 * deliberately not readable from the environment: a gate an operator (or a
 * compromised config) can open is not a gate.
 */
export const L6_SIGNED_OFF = false;

export const ISOLATION_BINARY = "bwrap";

/** Read-only system roots the child needs to execute anything at all. */
const RO_BINDS = ["/usr", "/etc"];
const SYMLINKS: Array<[string, string]> = [
  ["usr/lib", "/lib"],
  ["usr/lib64", "/lib64"],
  ["usr/bin", "/bin"],
  ["usr/sbin", "/sbin"],
];

/** Where an executable actually lives. A bare name means "somewhere on PATH",
 * and inside the namespace PATH is not the host's — so the name has to become
 * a path BEFORE the bind list is built, or the bind is never made. */
export function resolveExecutable(binary: string): string | null {
  if (binary.includes(path.sep)) {
    const abs = path.resolve(binary);
    try {
      accessSync(abs, constants.X_OK);
      return abs;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = path.join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function isolationAvailable(): boolean {
  return resolveExecutable(ISOLATION_BINARY) !== null;
}

/**
 * Wrap a command so it can only touch `cwd`. `--unshare-all` takes the
 * network with it, and `--die-with-parent` keeps the confined child from
 * outliving the gateway.
 */
export function confineArgv(
  cwd: string,
  binary: string,
  args: readonly string[],
): { binary: string; args: string[] } {
  // The host binary is usually NOT under /usr — pi lives in ~/.bun/bin, claude
  // in ~/.local/bin. Without its directory bound read-only the sandbox cannot
  // exec the very thing it is confining, and every confined run dies at exec.
  // `claude` and `pi` are bare names on PATH in every real config — resolving
  // them here is what makes the bind below exist at all.
  const resolved = resolveExecutable(binary) ?? path.resolve(binary);
  const binDir = path.dirname(resolved);
  const extra = RO_BINDS.some((p) => binDir === p || binDir.startsWith(`${p}/`))
    ? []
    : ["--ro-bind", binDir, binDir];
  const wrapped = [
    ...RO_BINDS.flatMap((p) => ["--ro-bind", p, p]),
    ...SYMLINKS.flatMap(([target, link]) => ["--symlink", target, link]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    // Its own /tmp: a shared one is a channel out of the sandbox.
    "--tmpfs",
    "/tmp",
    // AFTER the tmpfs: bwrap applies ops in order, so a bind listed earlier
    // would be masked by it — and a binary under /tmp is exactly the case a
    // test hits first.
    ...extra,
    "--bind",
    cwd,
    cwd,
    "--chdir",
    cwd,
    "--unshare-all",
    "--die-with-parent",
    resolved,
    ...args,
  ];
  return { binary: ISOLATION_BINARY, args: wrapped };
}

/**
 * The gate itself: null when the launch may proceed, a typed refusal when it
 * may not. A role that never asked for isolation is untouched — that is the
 * legacy path the spec keeps working.
 */
export function isolationRefusal(
  contract: ResolvedRoleContract,
): LaunchError | null {
  // `?? null` and not `=== null`: a contract pinned before the field existed
  // has no profile at all, and "absent" is the legacy path, not a request.
  if ((contract.binding.isolationProfileRef ?? null) === null) return null;
  if (!L6_SIGNED_OFF) {
    return {
      kind: "isolation-unavailable",
      message:
        `role asks for isolation profile ` +
        `"${contract.binding.isolationProfileRef}" but L6 is not signed off ` +
        "— executable roles stay disabled until the security review passes",
    };
  }
  // Deliberately NOT a per-launcher capability: confinement is `confineArgv`
  // applied in start.ts to whatever argv a launcher produced, so it works the
  // same for every host. Keying the gate to a capability only codex declared
  // (because of its own `-s`, which this file's own comment says is a
  // DIFFERENT mechanism) would refuse pi and claude for a confinement they can
  // in fact get. What actually decides is whether bwrap exists.
  if (!isolationAvailable()) {
    return {
      kind: "isolation-unavailable",
      message: `${ISOLATION_BINARY} not found on PATH`,
    };
  }
  return null;
}
