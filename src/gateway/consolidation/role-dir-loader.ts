/**
 * Role-dir loader — reads role.json + prompt.md from an explicit role
 * directory (canonical `roleDir/<name>/role.json` + bare `roleDir/<name>.json`
 * fallback). Used by day-runner/runner-helpers for per-role spawn wiring
 * (forked task-cycle path б): resolves against the orchestrator's roleDir so
 * tests can isolate roles without touching os.homedir().
 */
import fs from "node:fs";
import path from "node:path";
import { validateRoleConfig } from "../role-schema.js";
import type { RoleConfigFile } from "../role-files.js";

/** Read role.json from an explicit role dir (canonical + bare fallback). */
export function loadRoleConfigFromDir(
  roleName: string,
  roleDir: string,
): RoleConfigFile | null {
  const canon = path.join(roleDir, roleName, "role.json");
  const bare = path.join(roleDir, `${roleName}.json`);
  const target = fs.existsSync(canon) ? canon : bare;
  if (!fs.existsSync(target)) return null;
  try {
    return validateRoleConfig(JSON.parse(fs.readFileSync(target, "utf-8")));
  } catch {
    return null;
  }
}

/** Read role prompt from an explicit role dir (canonical + bare fallback). */
export function loadRolePromptFromDir(
  roleName: string,
  roleDir: string,
): string | null {
  const canon = path.join(roleDir, roleName, "prompt.md");
  const bare = path.join(roleDir, `${roleName}.md`);
  const target = fs.existsSync(canon) ? canon : bare;
  if (!fs.existsSync(target)) return null;
  try {
    return fs.readFileSync(target, "utf-8");
  } catch {
    return null;
  }
}
