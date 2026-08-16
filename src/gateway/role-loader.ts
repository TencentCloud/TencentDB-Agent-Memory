/**
 * Role file loaders + listing (wave tdai-memory-factory-2026-08-03).
 * Reads from canonical `roles/<name>/` (with strict schema validation) and
 * falls back to legacy `memory-keeper/<name>.{json,md}` with a WARN log.
 */
import fs from "node:fs";
import path from "node:path";
import {
  resolveLegacyRoleDir,
  resolvePerRoleDir,
  resolveRoleDirForRead,
} from "./role-paths.js";
import { defaultTdaiRoot } from "./tdai-root.js";
import { inspectRoleConfig, type RoleConfigFile } from "./role-schema.js";

/**
 * Last reported mtime+size per role.json path. /status lists every role on
 * every call, so an un-deduped WARN would print the same lines on each
 * request; the stamp makes it "once per edit" instead. Keyed by path (one
 * entry per file, not one per edit) for the same reason the contract cache in
 * role-contract.ts:54 is: a long-lived gateway must not grow a set entry every
 * time somebody saves the file.
 */
const reportedBadConfigs = new Map<string, string>();

/**
 * A role.json that does not validate leaves the role disabled — /status shows
 * `enabled: false` and /memory/run answers 409. Without this line the reason
 * exists nowhere: a schema change that outruns a running gateway silently
 * disables the whole pipeline, and the only symptom is a 409 with no cause.
 */
function warnUnusableRoleConfig(file: string, reason: string): void {
  let stamp = "unreadable";
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // Cannot stat: keep the constant stamp — one line per path, still deduped.
  }
  if (reportedBadConfigs.get(file) === stamp) return;
  reportedBadConfigs.set(file, stamp);
  process.stderr.write(
    `[role-files] WARN: ${file} is not a usable role contract (${reason}); ` +
      `the role stays disabled and /memory/run answers 409.\n`,
  );
}

/** Read + validate one role.json, naming the reason when it is unusable. */
function readRoleConfigFile(file: string): RoleConfigFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    warnUnusableRoleConfig(file, `unreadable JSON: ${String(error)}`);
    return null;
  }
  const inspection = inspectRoleConfig(parsed);
  if (inspection.kind === "valid") return inspection.config;
  warnUnusableRoleConfig(
    file,
    inspection.kind === "invalid"
      ? inspection.reason
      : `missing required fields: ${inspection.missing.join(", ")}`,
  );
  return null;
}

/** Read + validate `roles/<name>/role.json` (or legacy fallback). */
export function loadRoleConfig(
  roleName: string,
  root: string = defaultTdaiRoot(),
): RoleConfigFile | null {
  const canon = path.join(resolvePerRoleDir(roleName, root), "role.json");
  if (fs.existsSync(canon)) return readRoleConfigFile(canon);
  const legacy = path.join(resolveLegacyRoleDir(root), `${roleName}.json`);
  if (fs.existsSync(legacy)) {
    process.stderr.write(
      `[role-files] WARN: role "${roleName}" loaded from legacy path ${legacy}; ` +
      `migrate to roles/${roleName}/role.json before next release.\n`,
    );
    return readRoleConfigFile(legacy);
  }
  // Bare flat `<root>/<role>.json` — test/legacy compat (orchestrator tests
  // inject a custom roleDir and write `<role>.json` straight into it).
  const bare = path.join(root, `${roleName}.json`);
  if (fs.existsSync(bare)) return readRoleConfigFile(bare);
  return null;
}

/** Read the `roles/<name>/prompt.md` (or legacy fallback). */
export function loadRolePrompt(
  roleName: string,
  root: string = defaultTdaiRoot(),
): string | null {
  const canon = path.join(resolvePerRoleDir(roleName, root), "prompt.md");
  if (fs.existsSync(canon)) {
    try { return fs.readFileSync(canon, "utf-8"); } catch { return null; }
  }
  const legacy = path.join(resolveLegacyRoleDir(root), `${roleName}.md`);
  if (fs.existsSync(legacy)) {
    try { return fs.readFileSync(legacy, "utf-8"); } catch { return null; }
  }
  // Bare flat `<root>/<role>.md` — test/legacy compat (same as .json above).
  const bare = path.join(root, `${roleName}.md`);
  if (fs.existsSync(bare)) {
    try { return fs.readFileSync(bare, "utf-8"); } catch { return null; }
  }
  return null;
}

/** One role visible in /status. */
export interface RoleListing {
  name: string;
  enabled: boolean;
  model: string | null;
  hasPrompt: boolean;
  scope: string | null;
  trigger: string | null;
}

/** Discover all roles under `roles/`. */
export function listRoles(root: string = defaultTdaiRoot()): RoleListing[] {
  const rolesDir = resolveRoleDirForRead(root);
  let entries: string[];
  try {
    entries = fs.readdirSync(rolesDir);
  } catch {
    return [];
  }
  const out: RoleListing[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    const perRoleDir = path.join(rolesDir, name);
    let isDir = false;
    try { isDir = fs.statSync(perRoleDir).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    const cfg = loadRoleConfig(name, root);
    out.push({
      name,
      enabled: cfg?.enabled ?? false,
      model: cfg?.model ?? null,
      hasPrompt: loadRolePrompt(name, root) !== null,
      scope: cfg?.scope ?? null,
      trigger: cfg?.trigger ?? null,
    });
  }
  return out;
}

/** Compose the sub-session system prompt: role prompt + diff section. */
export function buildSessionPrompt(
  rolePrompt: string,
  diffSection: string,
): string {
  return `${rolePrompt.replace(/\s+$/, "")}\n\n${diffSection.trimEnd()}\n`;
}
