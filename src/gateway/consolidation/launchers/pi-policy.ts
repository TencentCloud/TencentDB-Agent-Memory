import type { ResolvedRoleContract } from "../role-contract-types.js";
import type { LauncherSettings } from "./pi-config.js";
import {
  DEFAULT_PI_FLAGS,
  stripOwnedFlags,
} from "./pi-config.js";

const AMBIENT_FLAGS = [
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-approve",
  "--tools",
  "--extension",
  "--skill",
  "--prompt-template",
  "--theme",
  "--append-system-prompt",
  "--system-prompt",
  "--mcp-config",
  "--exclude-tools",
  "-nt",
  "-t",
  "-xt",
  "-e",
  "-ne",
  "-ns",
  "-np",
  "-nc",
  "-a",
  "-na",
] as const;

const AMBIENT_NONE_FLAGS = AMBIENT_FLAGS.slice(0, 6);

export function piAssetArgs(contract: ResolvedRoleContract): string[] {
  const args: string[] = [];
  if (contract.assets.extensionPath) {
    args.push("--no-extensions", "--extension", contract.assets.extensionPath);
  }
  if (contract.assets.skillPath) args.push("--skill", contract.assets.skillPath);
  return args;
}

export function piFixedFlags(
  settings: LauncherSettings,
  contract: ResolvedRoleContract,
): string[] {
  const owned = ["--no-session", "--session-dir", "--session", "--session-id"];
  if (contract.assets.ambientAccess === "none") owned.push(...AMBIENT_FLAGS);
  const flags = stripOwnedFlags(settings.flags ?? [...DEFAULT_PI_FLAGS], owned);
  return contract.assets.ambientAccess === "none"
    ? [...flags, ...AMBIENT_NONE_FLAGS]
    : flags;
}
