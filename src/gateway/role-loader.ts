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
import { validateRoleConfig, type RoleConfigFile } from "./role-schema.js";

/** Read + validate `roles/<name>/role.json` (or legacy fallback). */
export function loadRoleConfig(
  roleName: string,
  root: string = defaultTdaiRoot(),
): RoleConfigFile | null {
  const canon = path.join(resolvePerRoleDir(roleName, root), "role.json");
  if (fs.existsSync(canon)) {
    try {
      const raw = fs.readFileSync(canon, "utf-8");
      return validateRoleConfig(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  const legacy = path.join(resolveLegacyRoleDir(root), `${roleName}.json`);
  if (fs.existsSync(legacy)) {
    process.stderr.write(
      `[role-files] WARN: role "${roleName}" loaded from legacy path ${legacy}; ` +
      `migrate to roles/${roleName}/role.json before next release.\n`,
    );
    try {
      const raw = fs.readFileSync(legacy, "utf-8");
      return validateRoleConfig(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  // Bare flat `<root>/<role>.json` — test/legacy compat (orchestrator tests
  // inject a custom roleDir and write `<role>.json` straight into it).
  const bare = path.join(root, `${roleName}.json`);
  if (fs.existsSync(bare)) {
    try {
      const raw = fs.readFileSync(bare, "utf-8");
      return validateRoleConfig(JSON.parse(raw));
    } catch {
      return null;
    }
  }
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
  criticRole: string | null;
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
      criticRole: cfg?.critic_role ?? null,
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
