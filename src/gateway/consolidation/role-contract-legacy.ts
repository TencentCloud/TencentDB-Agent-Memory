/**
 * LegacyRoleAdapter (tz-01 B3, model §3.3) — the ONLY place allowed to fill a
 * missing legacy value from the old global pi config, and it must say so in
 * `warnings`. A V2 package that lacks a required value is fail-closed instead;
 * that gate lives in role-contract.ts.
 *
 * It also translates today's `role.json` into the three model levels:
 *   model/thinking      → instance `ExecutionBinding` (not portable identity)
 *   runtime.extension_path/skill_path/scratch_root → instance assets
 *   scope               → an explicit `batching.strategy` enum
 */
import { createHash } from "node:crypto";
import { DEFAULT_RETRY_BUDGET, type RoleConfigFile } from "../role-schema.js";
import type { ApplyOp } from "../role-paths.js";
import type {
  BatchingStrategy,
  ExecutionBinding,
  ResolvedRoleContract,
  RoleLegacyDefaults,
  RoleScope,
  RoleTrigger,
} from "./role-contract-types.js";

/** Contract enum from the legacy `scope` field. Role NAMES are never
 * consulted — that is the whole point of tz-01 B2. */
export function strategyForScope(scope: RoleScope): BatchingStrategy {
  return scope === "fresh_tail"
    ? "fresh-tail-single-batch"
    : "bounded-full-store-chunked";
}

/** `provider/model` → provider. A model without a provider prefix keeps the
 * whole string as provider-less: the launcher still receives it verbatim. */
function providerOf(model: string): string {
  const i = model.indexOf("/");
  return i > 0 ? model.slice(0, i) : "";
}

export interface AdaptInput {
  role: string;
  cfg: RoleConfigFile;
  /** Fields absent from the file — each one filled here produces a warning. */
  missing: readonly string[];
  legacy: RoleLegacyDefaults;
  promptPath: string | null;
  promptText: string | null;
  source: ResolvedRoleContract["source"];
}

/**
 * Build the resolved contract. `missing` drives the warnings: a complete
 * contract produces none, which is what `source: "contract"` means.
 */
/**
 * What the role actually NEEDS, not only what it remembered to declare.
 *
 * `requires_capabilities` is opt-in, and no live role.json carries it — so a
 * role that ships an extension, a skill dir or an explicit thinking level
 * declared nothing, every host looked compatible, and a host without those
 * knobs ran the role STRIPPED and exited 0. That is the "худший исход" the
 * package's S5 names: a silent degraded launch instead of a refusal.
 *
 * Only EXPLICIT intent counts. `thinking` always resolves to a value because
 * the instance config has a default, and treating that default as a
 * requirement would make every host that lacks the knob refuse every role —
 * a gate that refuses everything protects nothing.
 */
function derivedCapabilities(cfg: RoleConfigFile): string[] {
  const need = new Set<string>(cfg.requires_capabilities ?? []);
  if (cfg.runtime?.extension_path) need.add("extension");
  if (cfg.runtime?.skill_path) need.add("skill");
  if (cfg.thinking !== undefined) need.add("thinking");
  return [...need].sort();
}

export function adaptRoleContract(input: AdaptInput): ResolvedRoleContract {
  const { role, cfg, legacy } = input;
  const warnings: string[] = [];
  const filled = (field: string, from: string): void => {
    if (input.missing.includes(field)) {
      warnings.push(`legacy fallback: "${field}" taken from ${from}`);
    }
  };

  const scope = (cfg.scope ?? "fresh_tail") as RoleScope;
  if (input.missing.includes("scope")) {
    warnings.push(
      'legacy fallback: "scope" absent → batching.strategy defaulted to ' +
        "fresh-tail-single-batch",
    );
  }
  const strategy = strategyForScope(scope);
  const isChunked = strategy === "bounded-full-store-chunked";
  const capSource = isChunked ? legacy.night : legacy;

  filled("model", "config.memory.consolidation.model");
  filled("thinking", "config.memory.consolidation.thinking");
  filled("timeout_min", "config.memory.consolidation.timeoutMs");
  filled("diff_cap", "config.memory.consolidation(.night).diffCap");
  filled("diff_byte_cap", "config.memory.consolidation(.night).diffByteCap");
  filled("caps", "config.memory.consolidation.night.*CapPerRun");
  filled("max_run_ms", "config.memory.consolidation.night.maxRunMs");
  if (input.missing.includes("tools_subset")) {
    warnings.push(
      'legacy fallback: "tools_subset" absent → the whole keeper-tools ' +
        "catalogue is copied, as before the contract",
    );
  }

  const model = cfg.model ?? legacy.model;
  const binding: ExecutionBinding = {
    launcherId: "pi",
    provider: providerOf(model),
    model,
    thinking: cfg.thinking ?? legacy.thinking,
    authProfileRef: null,
    isolationProfileRef: null,
  };

  const contract: ResolvedRoleContract = {
    role,
    enabled: cfg.enabled ?? true,
    source: input.source,
    warnings,
    contractHash: "",
    batching: {
      strategy,
      scope,
      diffCap: cfg.diff_cap ?? capSource.diffCap,
      diffByteCap: cfg.diff_byte_cap ?? capSource.diffByteCap,
      idsOnly: cfg.idsOnly ?? isChunked,
    },
    dispatch: {
      trigger: (cfg.trigger ?? "manual_only") as RoleTrigger,
      schedule: cfg.schedule ?? null,
      threshold: cfg.threshold ?? null,
    },
    policy: {
      opsSubset: new Set<ApplyOp>(cfg.ops_subset ?? []),
      caps: {
        deletePerRun: cfg.caps?.delete_per_run ?? legacy.night.deleteCapPerRun,
        rewritePerRun:
          cfg.caps?.rewrite_per_run ?? legacy.night.rewriteCapPerRun,
      },
      maxRunMs: cfg.max_run_ms ?? legacy.night.maxRunMs,
      retryBudget: cfg.retry_budget ?? DEFAULT_RETRY_BUDGET,
    },
    criticRole: cfg.critic_role ?? null,
    prompt: {
      file: cfg.prompt_file ?? `${role}.md`,
      path: input.promptPath,
      text: input.promptText,
      // Legacy default (unchanged): only the fail-open roles named by the
      // composition root tolerated a missing prompt.
      failOnMissing:
        cfg.fail_on_missing_prompt ??
        !legacy.failOpenPromptRoles.includes(role),
    },
    toolsSubset: cfg.tools_subset ? new Set<string>(cfg.tools_subset) : null,
    timeoutMs:
      typeof cfg.timeout_min === "number" && cfg.timeout_min > 0
        ? cfg.timeout_min * 60_000
        : legacy.timeoutMs,
    requiresCapabilities: derivedCapabilities(cfg),
    binding,
    assets: {
      extensionPath: cfg.runtime?.extension_path ?? null,
      skillPath: cfg.runtime?.skill_path ?? null,
      scratchRoot: cfg.runtime?.scratch_root ?? null,
    },
  };
  contract.contractHash = hashContract(contract);
  return contract;
}

/** Stable hash of everything that decides execution. tz-09 pins it into a
 * RoleRun so a mid-run edit of role.json cannot change the running contract.
 * `warnings` and the hash itself are excluded — they are diagnostics. */
export function hashContract(c: ResolvedRoleContract): string {
  const stable = {
    role: c.role,
    enabled: c.enabled,
    batching: c.batching,
    dispatch: c.dispatch,
    policy: {
      opsSubset: [...c.policy.opsSubset].sort(),
      caps: c.policy.caps,
      maxRunMs: c.policy.maxRunMs,
      retryBudget: c.policy.retryBudget,
    },
    criticRole: c.criticRole,
    prompt: { file: c.prompt.file, failOnMissing: c.prompt.failOnMissing },
    promptText: c.prompt.text,
    toolsSubset: c.toolsSubset ? [...c.toolsSubset].sort() : null,
    timeoutMs: c.timeoutMs,
    requiresCapabilities: c.requiresCapabilities,
    binding: c.binding,
    assets: c.assets,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
