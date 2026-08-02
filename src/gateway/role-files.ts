/**
 * Role files for memory-keeper sub-sessions (wave tdai-memory-subagents-2026-08
 * -02, P9). Auditors role pattern (`~/.pi/agent/auditors/<role>.json` + `<role>
 * .md`), located at `~/.pi/agent-memory/tdai/memory-keeper/`:
 *
 *   <role>.json — { name, model, prompt_file, enabled, thinking, timeout_min }
 *   <role>.md   — the role prompt (limits, task-simple instruction, report
 *                 format). The runtime file is created OPERATIONALLY (cp from
 *                 the repo canonical src/core/prompts/memory-keeper.md) — this
 *                 module is READ-ONLY by design: no file-writing calls here, so it
 *                 never enters the nogo-records-rewrite allowlist.
 *
 * The consolidation orchestrator composes the sub-session system prompt as
 *   role.md + `## Текущий дифф (что разгрести)` section (fence-escaped,
 *   double-capped — both live in diff-builder.ts, B3). Missing role file →
 *   fail-open fallback to the orchestrator's DEFAULT_ROLE_PROMPT.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Sub-directory of `~/.pi/agent-memory/tdai/` holding the role files. */
export const ROLE_DIR_NAME = "memory-keeper";

/** Absolute path of the memory-keeper role directory. */
export function resolveRoleDir(home: string = os.homedir()): string {
  return path.join(home, ".pi", "agent-memory", "tdai", ROLE_DIR_NAME);
}

/** Parsed `<role>.json` (auditors pattern). All fields optional. */
export interface RoleConfigFile {
  name?: string;
  model?: string;
  prompt_file?: string;
  enabled?: boolean;
  thinking?: string;
  timeout_min?: number;
}

/**
 * Read + parse `<role>.json`. Tolerates missing/malformed files (null) — the
 * orchestrator treats an absent role config as "defaults apply" (fail-open).
 */
export function loadRoleConfig(roleName: string, roleDir: string): RoleConfigFile | null {
  const file = path.join(roleDir, `${roleName}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      prompt_file: typeof parsed.prompt_file === "string" ? parsed.prompt_file : undefined,
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : undefined,
      thinking: typeof parsed.thinking === "string" ? parsed.thinking : undefined,
      timeout_min: typeof parsed.timeout_min === "number" ? parsed.timeout_min : undefined,
    };
  } catch {
    return null;
  }
}

/** Read the `<role>.md` prompt file; null when missing/unreadable (fail-open). */
export function loadRolePrompt(roleName: string, roleDir: string): string | null {
  try {
    return fs.readFileSync(path.join(roleDir, `${roleName}.md`), "utf-8");
  } catch {
    return null;
  }
}

/** One role visible in /status. */
export interface RoleListing {
  name: string;
  enabled: boolean;
  model: string | null;
  hasPrompt: boolean;
}

/**
 * Scan the role directory for `<name>.json` / `<name>.md` pairs. A role is
 * listed when either file exists. `enabled` defaults to true when the json is
 * absent or omits the flag (fail-open — an operator dropping the file must not
 * silently disable the keeper).
 */
export function listRoles(roleDir: string): RoleListing[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(roleDir);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.endsWith(".json")) names.add(entry.slice(0, -".json".length));
    else if (entry.endsWith(".md")) names.add(entry.slice(0, -".md".length));
  }
  const out: RoleListing[] = [];
  for (const name of [...names].sort()) {
    const cfg = loadRoleConfig(name, roleDir);
    out.push({
      name,
      enabled: cfg?.enabled ?? true,
      model: cfg?.model ?? null,
      hasPrompt: loadRolePrompt(name, roleDir) !== null,
    });
  }
  return out;
}

/**
 * Compose the sub-session system prompt (ТЗ §5.4): role prompt + the
 * `## Текущий дифф (что разгрести)` section. The diff section is already
 * fence-escaped and double-capped by buildDiffSection (diff-builder.ts) — the
 * role prompt and the data block are kept as separate top-level blocks so an
 * embedded fence can never restructure the role instructions.
 */
export function buildSessionPrompt(rolePrompt: string, diffSection: string): string {
  return `${rolePrompt.replace(/\s+$/, "")}\n\n${diffSection.trimEnd()}\n`;
}
