/**
 * RoleLauncher port (tz-06 §Контракт порта).
 *
 * One substitution point for everything host-specific. Above this line the
 * pipeline knows a role, a prompt and a scratch dir; below it a host knows
 * binaries, flags and sessions. `no-host-hardcode`: no binary name and no
 * host flag exists outside `launchers/`.
 *
 * The lifecycle guarantees of `RunningHandle` (terminal result only after
 * `close` + reap, idempotent cancel, bounded output) are the subject of Ф2 —
 * Ф1 only moves the existing spawn behind this interface, unchanged.
 */
import type { ResolvedRoleContract } from "../role-contract-types.js";

export type LaunchErrorKind =
  | "binary-not-found"
  | "permission-denied"
  | "host-incompatible"
  | "invalid-binding"
  | "isolation-unavailable"
  /** Not a declared refusal: the launcher itself threw. Kept in the same
   * union so the service boundary has exactly one error shape to record. */
  | "internal-launcher";

export interface LaunchError {
  kind: LaunchErrorKind;
  message: string;
}

export type HostRunStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

/** Terminal outcome of one attempt. Anything but `succeeded` — and any
 * non-zero exit code — forbids parse/apply (tz-06 §Контракт порта). */
export interface HostRunResult {
  status: HostRunStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Set when the host itself failed rather than the role. */
  error?: string;
  /** The same failure, typed, when it is the host refusing to launch. */
  launchError?: LaunchError;
}

export interface RunningHandle {
  /** What identifies this attempt's session on the host (a path, an id — the
   * shape is the launcher's business). Empty while a launcher has no session
   * concept yet. */
  sessionRef: string;
  completion: Promise<HostRunResult>;
  /** Stop the attempt and resolve to the SAME terminal result `completion`
   * gives. Idempotent. */
  cancelAndWait: () => Promise<HostRunResult>;
}

export interface LaunchInput {
  runId: string;
  /** The attempt this launch IS. Sessions are per attempt, not per run. */
  attemptId: string;
  /** Working dir of the attempt; also where the role leaves diff.json. */
  cwd: string;
  /** System prompt file prepared by the pipeline. */
  promptPath: string;
  taskPrompt: string;
  env: Record<string, string>;
  /** Everything the role's own contract decides: model, thinking, assets,
   * timeout, tools subset. A launcher reads it, never a config file. */
  contract: ResolvedRoleContract;
  /** Called right after the process exists, for kill-handle registration. */
  onSpawn?: (kill: () => void) => void;
}

export type LaunchOutcome =
  { ok: true; handle: RunningHandle } | { ok: false; error: LaunchError };

export interface RoleLauncher {
  /** Matches `ExecutionBinding.launcherId`. */
  readonly id: string;
  /** What this host can actually do (tz-06 L5). Checked against the role's
   * `requiresCapabilities` BEFORE the process exists — see capabilities.ts. */
  readonly capabilities: ReadonlySet<string>;
  launch(input: LaunchInput): Promise<LaunchOutcome>;
}
