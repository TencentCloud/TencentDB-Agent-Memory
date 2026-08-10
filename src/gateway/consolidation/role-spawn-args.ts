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
import type { ResolvedRoleContract } from "./role-contract-types.js";

/** Build --no-extensions/--extension/--skill CLI args from the contract's
 * instance assets (tz-01: assets come from the resolved contract, never from
 * a second read of role.json). */
export function buildRoleSpawnArgs(contract: ResolvedRoleContract): string[] {
  const extraArgs: string[] = [];
  if (contract.assets.extensionPath) {
    extraArgs.push(
      "--no-extensions",
      "--extension",
      contract.assets.extensionPath,
    );
  }
  if (contract.assets.skillPath) {
    extraArgs.push("--skill", contract.assets.skillPath);
  }
  return extraArgs;
}
