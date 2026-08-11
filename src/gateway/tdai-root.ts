/**
 * The single resolver for the TDAI data root (tz-07 H1).
 *
 * The root is an ARGUMENT, not a process global: two live sources of the root
 * ARE the split R1 warns about. `defaultTdaiRoot()` is the last resort for the
 * places that have no caller to take a root from — production callers pass
 * `config.data.baseDir` (gateway) or the host-injected plugin data dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnv } from "../utils/env.js";
import { resolveDefaultDataDir } from "./config.js";

/** Pre-tz-07 root every path was hardcoded against; read-only from now on. */
const LEGACY_ROOT_SEGMENTS = [".pi", "agent-memory", "tdai"];

let cachedDefault: string | null = null;
let deprecationWarned = false;

function expandTilde(p: string): string {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";
  return p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/**
 * Last-resort root. Delegates to the config resolver rather than
 * re-implementing its tail: a private chain would drop the legacy
 * `~/memory-tdai` branch and hand roles a different root than memory.
 *
 * The yaml `data.baseDir` rung is unreachable from here (it needs a parsed
 * config file) — that rung is covered by callers passing the root explicitly.
 */
export function defaultTdaiRoot(): string {
  if (cachedDefault !== null) return cachedDefault;
  cachedDefault = expandTilde(
    getEnv("TDAI_DATA_DIR") ?? resolveDefaultDataDir(),
  );
  return cachedDefault;
}

/** Tests only: the default is memoized per process (tz-07 НФТ "no I/O per call"). */
export function resetTdaiRootCacheForTests(): void {
  cachedDefault = null;
  deprecationWarned = false;
}

/** The only way to build a path under the root. */
export function resolveUnderRoot(root: string, ...segments: string[]): string {
  return path.join(root, ...segments);
}

/**
 * Read-only fallback to the pre-tz-07 location (H2, criterion 3): if the path
 * does not exist under the new root but does under `~/.pi/agent-memory/tdai`,
 * read the old one and say so once.
 *
 * Writes never come through here — the new root always wins for writes, so a
 * rollback is "point the root back", not "you are stuck on the old root".
 */
export function legacyReadPath(root: string, ...segments: string[]): string {
  const fresh = resolveUnderRoot(root, ...segments);
  if (fs.existsSync(fresh)) return fresh;
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? os.homedir();
  const legacy = path.join(home, ...LEGACY_ROOT_SEGMENTS, ...segments);
  if (!fs.existsSync(legacy)) return fresh;
  if (!deprecationWarned) {
    deprecationWarned = true;
    process.stderr.write(
      `[tdai] DEPRECATED: reading ${legacy}; move it under ${root} ` +
        `(writes already go there).\n`,
    );
  }
  return legacy;
}
