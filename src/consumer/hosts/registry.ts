/**
 * tz-08 Ф4 — the registry of hosts that can run the consumer.
 *
 * One table, one lookup. An unknown host does not throw and does not fall back
 * to "something close enough": it comes back as `incompatible-host`, naming the
 * hosts that do work (ТЗ D1b).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeHost } from "./claude.js";
import { codexHost } from "./codex.js";
import { piHost } from "./pi.js";
import type { HostContext, HostDescriptor, HostLookup } from "./types.js";

const HOSTS: Readonly<Record<string, (ctx: HostContext) => HostDescriptor>> = {
  pi: piHost,
  claude: claudeHost,
  codex: codexHost,
};

/** Host ids this build can register the consumer with. */
export const KNOWN_HOSTS: readonly string[] = Object.keys(HOSTS);

export function describeHost(id: string, ctx: HostContext): HostLookup {
  const build = HOSTS[id];
  if (!build) {
    return {
      ok: false,
      kind: "incompatible-host",
      message: `no consumer registration for host "${id}" — known hosts: ${KNOWN_HOSTS.join(", ")}`,
      known: KNOWN_HOSTS,
    };
  }
  return { ok: true, descriptor: build(ctx) };
}

/** Every host's descriptor, for generating documentation or a setup sweep. */
export function describeAllHosts(ctx: HostContext): HostDescriptor[] {
  return KNOWN_HOSTS.map((id) => HOSTS[id]!(ctx));
}

/** Raised when the launcher cannot be located — a packaging fault, not input. */
export class LauncherNotFoundError extends Error {
  constructor(startDir: string) {
    super(
      `could not locate bin/tdai-memory-mcp.mjs above ${startDir} — ` +
        "the package layout is not what this build expects",
    );
    this.name = "LauncherNotFoundError";
  }
}

/**
 * Absolute path of the launcher a registration should point at.
 *
 * Resolved by walking up to the package root rather than counting `..`
 * segments: this module runs both from `src/consumer/hosts/` and from the
 * bundled `dist/`, which sit at different depths.
 */
export function resolveLauncherPath(
  startDir = path.dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = startDir;
  for (;;) {
    const launcher = path.join(dir, "bin", "tdai-memory-mcp.mjs");
    if (fs.existsSync(launcher)) return launcher;
    const parent = path.dirname(dir);
    if (parent === dir) throw new LauncherNotFoundError(startDir);
    dir = parent;
  }
}
