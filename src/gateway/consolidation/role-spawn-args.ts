/**
 * Role spawn args — forked task-cycle wiring (path б): role.json
 * `runtime.extension_path` / `skill_path` → `--extension` / `--skill` CLI
 * args for the keeper sub-session. Legacy roles resolve to no extra args.
 *
 * When a role carries its own extensions, ambient extensions are DISABLED
 * (`--no-extensions`) — same contract as pi-subagents path а
 * (pi-args.ts: disableAmbientExtensions when `extensions` is set): the
 * forked task-cycle registers the same tool names as the ambient original
 * (task_init…task_finish), and pi treats tool-name conflicts as fatal
 * (resource-loader detectExtensionConflicts → exit 1). The role sub-session
 * runs in its own sandbox (cwd=runs/<role>) and needs only its fork.
 */
import type { SpawnChildContext } from "./types.js";
import { resolveRoleRuntimeFromDir } from "./role-runtime.js";

/** Build --no-extensions/--extension/--skill CLI args from the role runtime. */
export function buildRoleSpawnArgs(
  childCtx: SpawnChildContext,
  roleDir: string,
): string[] {
  const roleRt = resolveRoleRuntimeFromDir(childCtx.role, roleDir);
  const extraArgs: string[] = [];
  if (roleRt?.runtime.extensionPath) {
    extraArgs.push(
      "--no-extensions",
      "--extension",
      roleRt.runtime.extensionPath,
    );
  }
  if (roleRt?.runtime.skillPath) {
    extraArgs.push("--skill", roleRt.runtime.skillPath);
  }
  return extraArgs;
}
