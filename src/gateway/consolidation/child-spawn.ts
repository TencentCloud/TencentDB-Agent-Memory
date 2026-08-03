/**
 * Memory-keeper child process management (wave tdai-memory-subagents-2026-08
 * -02, P6). Spawn + run-wrapper of the pi sub-session ("пчёлка").
 *
 * Spawn contract (ТЗ §5.1):
 *   spawn(pi, ["-p","--no-context-files","--no-session","--model",<model>,
 *              "--thinking",<level>,"--system-prompt",<sess-prompt>,<задание>],
 *         { cwd: <scratch-dir>, env: <whitelist>, stdio: pipe, detached: true })
 *   — WITHOUT --no-skills (the child needs skills/subagents for task-simple);
 *   cwd = scratch dir OUTSIDE the memory tree; stdout/stderr data listeners
 *   attach immediately (live pipe drain — a stalled >64KB pipe deadlocks the
 *   child); --thinking output lands on stderr (stdout = errors/report only).
 *
 * Env whitelist is EXPLICIT and exhaustive: PATH, HOME, PI_MEMORY_KEEPER=1,
 * PI_MEMORY_KEEPER_RUN=<uuid>, TDAI_GATEWAY_URL. Auth keys and the loopback
 * token are excluded by construction (INVARIANT nogo-secrets).
 *
 * /proc helpers, group-kill and the orphan sweep live in keeper-proc.ts /
 * keeper-sweep.ts (re-exported here for backward compat).
 */

import {
  ENV_KEEPER,
  ENV_RUN,
  ENV_OWNER,
  ENV_GATEWAY_URL,
} from "./keeper-proc.js";

export {
  ENV_KEEPER,
  ENV_RUN,
  ENV_OWNER,
  ENV_GATEWAY_URL,
} from "./keeper-proc.js";
export {
  parsePgrpFromStat,
  readPgrpOf,
  snapshotPgrp,
  killProcessGroup,
  killPid,
  killChildGroup,
} from "./keeper-proc.js";
export type { KillOutcome } from "./keeper-proc.js";
export {
  scanKeeperProcesses,
  sweepKeeperOrphans,
  type OrphanCandidate,
} from "./keeper-sweep.js";
export type { ChildRunResult } from "./keeper-run.js";
export type { RunKeeperOptions } from "./keeper-run.js";

export interface ChildEnvDeps {
  home: string;
  pathValue: string;
  gatewayUrl: string;
  runUuid: string;
  /** Orchestrator pid that spawns the keeper — enables the cross-orchestrator
   * owner guard in sweepKeeperOrphans (parallel smoke + live gateway). */
  ownerPid: number;
}

/**
 * Build the child environment — an EXPLICIT whitelist. Nothing else is copied
 * from process.env: auth keys, loopback token and provider secrets never reach
 * the sub-session (INVARIANT nogo-secrets). The provider key the child's model
 * needs is read by opencode-go itself from ~/.pi/agent/auth.json via HOME.
 */
export function buildChildEnv(deps: ChildEnvDeps): Record<string, string> {
  const env: Record<string, string> = {
    PATH: deps.pathValue,
    HOME: deps.home,
    [ENV_KEEPER]: "1",
    [ENV_RUN]: deps.runUuid,
    [ENV_OWNER]: String(deps.ownerPid),
    [ENV_GATEWAY_URL]: deps.gatewayUrl,
  };
  // Deliberately no other keys. Loopback token and apiKey are NOT here.
  return env;
}
