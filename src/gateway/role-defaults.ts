/**
 * Snapshot of the global consolidation knobs for the role path (tz-01).
 *
 * The orchestrator receives these as plain values instead of reaching into
 * `config.memory.consolidation.*` itself: role parameters must come from the
 * resolved contract (`contract-drives-execution`), and this snapshot is only
 * what the LegacyRoleAdapter may fall back to for an incomplete legacy
 * `role.json` — every such fallback is reported as a warning.
 *
 * Takes the config SECTION, not the whole config, so the role path has no
 * way to read anything else from it.
 */
import type { ConsolidationConfig } from "../config.js";
import type {
  RoleLegacyDefaults,
} from "./consolidation/role-contract-types.js";

export function buildRoleDefaults(
  cfg: ConsolidationConfig,
): RoleLegacyDefaults {
  return {
    // Pre-contract behaviour: only the day keeper ran without a prompt file.
    failOpenPromptRoles: ["memory-keeper"],
    model: cfg.model,
    thinking: cfg.thinking,
    timeoutMs: cfg.timeoutMs,
    diffCap: cfg.diffCap,
    diffByteCap: cfg.diffByteCap,
    night: {
      diffCap: cfg.night.diffCap,
      diffByteCap: cfg.night.diffByteCap,
      deleteCapPerRun: cfg.night.deleteCapPerRun,
      rewriteCapPerRun: cfg.night.rewriteCapPerRun,
      maxRunMs: cfg.night.maxRunMs,
    },
  };
}
