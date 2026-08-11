/**
 * The single resolver of a role contract (tz-01 B1): every consumer — spawn,
 * tools, prompt, dispatcher, caps — goes through `resolveRoleContract`, and
 * nothing else reads `role.json`.
 *
 * Fail-closed (`fail-closed-role`): broken JSON, an unknown field, a wrongly
 * typed value or a missing prompt under `fail_on_missing_prompt` disable the
 * role WITH a reason. A file that is merely incomplete (legacy minimal role)
 * is handed to the LegacyRoleAdapter, which fills the gaps from the global
 * snapshot and records a warning for each one.
 *
 * Cache: keyed by role dir + role, invalidated by mtime/size of role.json and
 * of the resolved prompt (NFR: resolve ≤5 ms).
 */
import fs from "node:fs";
import path from "node:path";
import { inspectRoleConfig } from "../role-schema.js";
import { adaptRoleContract } from "./role-contract-legacy.js";
import { resolveRolePrompt } from "./role-contract-prompt.js";
import { resolveRoleDirForRead } from "../role-files.js";
import type {
  ResolvedRoleContract,
  RoleLegacyDefaults,
  RoleResolution,
} from "./role-contract-types.js";

/** `<roleDir>/<role>/role.json`, else the bare `<roleDir>/<role>.json`. */
function contractPath(role: string, roleDir: string): string | null {
  const canonical = path.join(roleDir, role, "role.json");
  if (fs.existsSync(canonical)) return canonical;
  const bare = path.join(roleDir, `${role}.json`);
  return fs.existsSync(bare) ? bare : null;
}

/** mtime+size stamp, "" when the file is absent (absence is also a state). */
function stamp(p: string | null): string {
  if (p === null) return "";
  try {
    const s = fs.statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

interface CacheEntry {
  jsonPath: string | null;
  jsonStamp: string;
  promptPath: string | null;
  promptStamp: string;
  resolution: RoleResolution;
}

const cache = new Map<string, CacheEntry>();

/** Drop the memoized contracts (tests and an explicit reload). */
export function clearRoleContractCache(): void {
  cache.clear();
}

function disabled(role: string, reason: string): RoleResolution {
  return { ok: false, role, reason };
}

function resolveFresh(
  role: string,
  roleDir: string,
  legacy: RoleLegacyDefaults,
  jsonPath: string | null,
): { resolution: RoleResolution; promptPath: string | null } {
  let raw: unknown;
  if (jsonPath !== null) {
    let text: string;
    try {
      text = fs.readFileSync(jsonPath, "utf-8");
    } catch (err) {
      return {
        resolution: disabled(
          role,
          `role.json unreadable (${err instanceof Error ? err.message : String(err)})`,
        ),
        promptPath: null,
      };
    }
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err) {
      return {
        resolution: disabled(
          role,
          `role.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        ),
        promptPath: null,
      };
    }
  }

  const inspection =
    jsonPath === null ? ({ kind: "absent" } as const) : inspectRoleConfig(raw);
  if (inspection.kind === "invalid") {
    return {
      resolution: disabled(role, `role.json rejected: ${inspection.reason}`),
      promptPath: null,
    };
  }

  const cfg = inspection.kind === "absent" ? {} : inspection.config;
  const missing =
    inspection.kind === "valid"
      ? []
      : inspection.kind === "partial"
        ? inspection.missing
        : // absent: everything is filled from the legacy snapshot
          [
            "scope",
            "model",
            "thinking",
            "timeout_min",
            "diff_cap",
            "diff_byte_cap",
            "caps",
            "max_run_ms",
            "tools_subset",
          ];
  const source =
    inspection.kind === "valid"
      ? "contract"
      : inspection.kind === "partial"
        ? "legacy-partial"
        : "legacy-absent";

  const promptFile = cfg.prompt_file ?? `${role}.md`;
  const prompt = resolveRolePrompt(role, roleDir, promptFile);
  const contract = adaptRoleContract({
    role,
    cfg,
    missing,
    legacy,
    promptPath: prompt.path,
    promptText: prompt.text,
    source,
  });
  contract.warnings.push(...prompt.warnings);

  if (contract.prompt.text === null && contract.prompt.failOnMissing) {
    return {
      resolution: disabled(
        role,
        `prompt "${promptFile}" not found under ${roleDir} and ` +
          "fail_on_missing_prompt is set",
      ),
      // The path the prompt WOULD occupy: creating that file must invalidate
      // this fail-closed entry, otherwise the role stays disabled until a
      // gateway restart.
      promptPath: prompt.expectedPath,
    };
  }
  return {
    resolution: { ok: true, contract },
    promptPath: prompt.path ?? prompt.expectedPath,
  };
}

/** Resolve one role. Cached; the cache is invalidated by file mtime/size. */
export function resolveRoleContract(
  role: string,
  roleDir: string,
  legacy: RoleLegacyDefaults,
): RoleResolution {
  // JSON pair, not a raw separator byte: a control character in the source
  // makes git treat this file as binary (no diff, no grep).
  const key = JSON.stringify([roleDir, role]);
  const jsonPath = contractPath(role, roleDir);
  const hit = cache.get(key);
  if (
    hit &&
    hit.jsonPath === jsonPath &&
    hit.jsonStamp === stamp(jsonPath) &&
    hit.promptStamp === stamp(hit.promptPath)
  ) {
    return hit.resolution;
  }
  const { resolution, promptPath } = resolveFresh(
    role,
    roleDir,
    legacy,
    jsonPath,
  );
  cache.set(key, {
    jsonPath,
    jsonStamp: stamp(jsonPath),
    promptPath,
    promptStamp: stamp(promptPath),
    resolution,
  });
  return resolution;
}

/** Every role directory under `roleDir`, resolved. Disabled roles are kept —
 * a broken package must stay VISIBLE, not vanish from the registry. */
export function listRoleContracts(
  roleDir: string,
  legacy: RoleLegacyDefaults,
): RoleResolution[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(roleDir).sort();
  } catch {
    return [];
  }
  const out: RoleResolution[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(roleDir, name)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    out.push(resolveRoleContract(name, roleDir, legacy));
  }
  return out;
}

/**
 * Every scratch root the roles on disk declare (tz-02 Ф5). Cleanup needs them
 * because `keep_scratch` leaves attempt dirs behind and a role's own root is
 * not under the instance root — nothing else would ever sweep it.
 */
export function roleScratchRoots(
  legacy: RoleLegacyDefaults,
  roleDir: string = resolveRoleDirForRead(),
): string[] {
  const roots = new Set<string>();
  for (const res of listRoleContracts(roleDir, legacy)) {
    if (res.ok && res.contract.assets.scratchRoot !== null) {
      roots.add(res.contract.assets.scratchRoot);
    }
  }
  return [...roots];
}

export type { ResolvedRoleContract, RoleResolution, RoleLegacyDefaults };
