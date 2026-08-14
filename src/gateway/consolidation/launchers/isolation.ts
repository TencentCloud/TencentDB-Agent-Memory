/**
 * Isolation gate L6 (tz-06 Ф6) — security, Tier-2.
 *
 * Two separate things live here, and conflating them is how a gate becomes a
 * formality:
 *
 *   1. the MECHANISM — `bwrap`, a mount+process namespace: the child sees a
 *      read-only system, its own scratch and its own /tmp. The approved
 *      `scratch-net-v1` profile retains network for the model API;
 *   2. the POLICY — whether a role is ALLOWED to run confined yet. That is
 *      `L6_SIGNED_OFF`; executable roles still fail closed if the supported
 *      profile or `bwrap` is unavailable.
 *
 * A requested profile is never launched unconfined as a fallback.
 */
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import type { ResolvedRoleContract } from "../role-contract-types.js";
import type { LaunchError } from "./types.js";

/**
 * L6 exit criterion. Flipping this to `true` is a SECURITY decision that the
 * tz-06 spec routes through a separate review — it is not a config value and
 * deliberately not readable from the environment: a gate an operator (or a
 * compromised config) can open is not a gate.
 */
export const L6_SIGNED_OFF = true;

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
      return realpathSync(abs);
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = path.join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
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
 * Wrap a command so it can only mutate `cwd`. `scratch-net-v1` keeps network
 * available for the model API while isolating every other namespace.
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
  const bunModules = resolved.includes("/.bun/install/global/node_modules/")
    ? resolved.slice(0, resolved.indexOf("/node_modules/") + 14)
    : null;
  const runtimeRoots = bunModules ? [bunModules] : [];
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
    ...runtimeRoots.flatMap((root) => ["--ro-bind", root, root]),
    "--bind",
    cwd,
    cwd,
    "--chdir",
    cwd,
    "--unshare-user",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-cgroup",
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
  if (contract.binding.isolationProfileRef !== "scratch-net-v1") {
    return {
      kind: "isolation-unavailable",
      message: `unknown isolation profile "${contract.binding.isolationProfileRef}"`,
    };
  }
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
