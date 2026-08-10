/**
 * ResolvedRoleContract — the single shape every consumer of a role reads
 * (tz-01 B1). Once it exists, nothing downstream may go back to the global
 * config for a role parameter (`contract-drives-execution`).
 *
 * Three levels of truth from the model (§3.3), collapsed into one resolved
 * value: portable package fields (batching, policy, prompt, tools, critic),
 * instance fields (`ExecutionBinding`, assets, enabled) and the hash that
 * tz-09 pins into a RoleRun.
 */
import type { ApplyOp } from "../role-paths.js";
import type { ROLE_SCOPES, ROLE_TRIGGERS } from "../role-schema.js";

export type RoleScope = (typeof ROLE_SCOPES)[number];
export type RoleTrigger = (typeof ROLE_TRIGGERS)[number];

/**
 * Named batching strategy — an explicit contract enum, NOT a role name and
 * not a time of day (tz-01 B2). `fresh-tail-single-batch` is the day keeper
 * semantics; `bounded-full-store-chunked` is the night/dedup sweep bounded
 * by NIGHT_SWEEP_LIMIT and cut into chunks in memory.
 */
export type BatchingStrategy =
  "fresh-tail-single-batch" | "bounded-full-store-chunked";

/**
 * Instance-level execution binding (§3.4): launcher, provider and model are
 * fixed for the role and pinned into the run. There is no "pick one for me"
 * default. `launcherId` is legacy-versioned here: today only pi exists, the
 * host swap is tz-06.
 */
export interface ExecutionBinding {
  launcherId: "pi";
  provider: string;
  model: string;
  thinking: string;
  /** Filled by tz-07 (auth roots); explicit null until then, never guessed. */
  authProfileRef: string | null;
  /** Filled by tz-06 (isolation profiles); explicit null until then. */
  isolationProfileRef: string | null;
}

export interface ResolvedRoleContract {
  role: string;
  enabled: boolean;
  /** Where the values came from — `contract` means nothing was inferred. */
  source: "contract" | "legacy-partial" | "legacy-absent";
  /** Every value the LegacyRoleAdapter had to invent, one line each. */
  warnings: string[];
  contractHash: string;
  batching: {
    strategy: BatchingStrategy;
    scope: RoleScope;
    diffCap: number;
    diffByteCap: number;
    idsOnly: boolean;
  };
  dispatch: {
    trigger: RoleTrigger;
    schedule: string | null;
    threshold: number | null;
  };
  policy: {
    opsSubset: ReadonlySet<ApplyOp>;
    caps: { deletePerRun: number; rewritePerRun: number };
    maxRunMs: number;
    retryBudget: number;
  };
  criticRole: string | null;
  prompt: {
    /** `prompt_file` as written in the contract. */
    file: string;
    /** Absolute path actually used, or null when nothing was found. */
    path: string | null;
    text: string | null;
    failOnMissing: boolean;
  };
  /** Declared tools, or null when the legacy file never declared any — null
   * keeps the pre-tz-01 behaviour (the whole catalogue) instead of silently
   * leaving the role with no tools. An empty SET means "declared none". */
  toolsSubset: ReadonlySet<string> | null;
  timeoutMs: number;
  binding: ExecutionBinding;
  assets: {
    extensionPath: string | null;
    skillPath: string | null;
    scratchRoot: string | null;
  };
}

/** Fail-closed result: a role either resolves or is disabled WITH a reason
 * (`fail-closed-role` — never a silent null). */
export type RoleResolution =
  | { ok: true; contract: ResolvedRoleContract }
  | { ok: false; role: string; reason: string };

/**
 * Global values the LegacyRoleAdapter — and only it — may fall back to for a
 * legacy role file. Collected at the composition root (server.ts) and passed
 * in, so no module under consolidation/ reads `config.memory.*` itself.
 */
export interface RoleLegacyDefaults {
  /** Roles whose prompt was fail-OPEN before the contract existed (the day
   * keeper). Comes from the composition root: a role name must never be
   * compared against a literal inside consolidation/ (tz-01 B2). */
  failOpenPromptRoles: readonly string[];
  model: string;
  thinking: string;
  timeoutMs: number;
  diffCap: number;
  diffByteCap: number;
  night: {
    diffCap: number;
    diffByteCap: number;
    deleteCapPerRun: number;
    rewriteCapPerRun: number;
    maxRunMs: number;
  };
}


