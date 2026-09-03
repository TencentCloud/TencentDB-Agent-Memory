/**
 * Header-driven identity pre-selection.
 *
 * When the client (main agent) already carries the identity in request headers
 * (e.g. `x-team-id` / `x-agent-id` / `x-task-id`), we validate those values
 * against the team/agent/task lists the authenticated user can actually see and,
 * if they exist, skip the corresponding interactive selection form.
 *
 * Security: values are ONLY honored when they are found inside the
 * kernel-provided `teams[]` (i.e. within the caller's own tenant scope). A
 * header value that doesn't match any list entry is treated as a mismatch and
 * NEVER trusted blindly — see `handleSessionInit` for the `onMismatch` handling.
 */

import type { SessionInitConfig } from "../types.js";
import type { TeamOption } from "./types.js";

/** Raw identity values parsed from request headers (may be partial / absent). */
export interface PresetIdentity {
  teamId?: string;
  agentId?: string;
  taskId?: string;
}

/** Result of validating a {@link PresetIdentity} against the user's team list. */
export interface PresetResolution {
  /** Validated team_id (present only when the header team matched a real team). */
  teamId?: string;
  /** Validated agent_id (present only when it belongs to the matched team). */
  agentId?: string;
  /** Validated task_id (present only when it belongs to the matched team). */
  taskId?: string;
  /**
   * True when team+agent are both resolved → the session can be registered
   * directly without any form (task is optional).
   */
  canRegister: boolean;
  /**
   * True when any *provided* header value could not be validated against the
   * list (unknown team, or agent/task not in the matched team). Callers fall
   * back to the interactive form (or bypass) per `headerAutoSelect.onMismatch`.
   */
  hadMismatch: boolean;
}

export interface PresetResolutionOptions {
  taskMissingPolicy?: "skip" | "default" | "reject";
  defaultTaskId?: string;
}

/**
 * Parse the preset identity from lowercased request headers using the configured
 * header names. Returns undefined when header auto-select is disabled or no team
 * header is present (the common case → callers keep the original flow untouched).
 */
export function parsePresetIdentity(
  config: SessionInitConfig,
  lcHeaders: Record<string, string>,
): PresetIdentity | undefined {
  const cfg = config.headerAutoSelect;
  if (!cfg || !cfg.enabled) return undefined;

  const teamId = (lcHeaders[cfg.teamHeader] ?? "").trim();
  // No team header → nothing to pre-select; keep the interactive flow.
  if (!teamId) return undefined;

  const agentId = (lcHeaders[cfg.agentHeader] ?? "").trim();
  const taskId = (lcHeaders[cfg.taskHeader] ?? "").trim();
  return {
    teamId,
    agentId: agentId || undefined,
    taskId: taskId || undefined,
  };
}

/**
 * Validate a preset identity against the user-visible team list.
 *
 * Only values that actually exist in `teams[]` are echoed back; any provided
 * value that is not found flips `hadMismatch`.
 */
export function resolvePresetIdentity(
  teams: TeamOption[],
  preset: PresetIdentity,
  options: PresetResolutionOptions = {},
): PresetResolution {
  const res: PresetResolution = {
    canRegister: false,
    hadMismatch: false,
  };
  if (!preset.teamId) return res;

  const team = teams.find((t) => t.team_id === preset.teamId);
  if (!team) {
    // Unknown team → don't trust anything from this header set.
    res.hadMismatch = true;
    return res;
  }
  res.teamId = team.team_id;

  if (preset.agentId) {
    const agent = team.agents.find((a) => a.agent_id === preset.agentId);
    if (agent) res.agentId = agent.agent_id;
    else res.hadMismatch = true;
  }

  if (preset.taskId) {
    const task = team.tasks.find((t) => t.task_id === preset.taskId);
    if (task) res.taskId = task.task_id;
    else res.hadMismatch = true;
  } else if (options.taskMissingPolicy === "reject") {
    res.hadMismatch = true;
  } else if (options.taskMissingPolicy === "default") {
    if (options.defaultTaskId) res.taskId = options.defaultTaskId;
    else res.hadMismatch = true;
  }

  // team + agent resolved → register directly. A genuinely missing task may
  // remain undefined (skip), map to defaultTaskId, or reject. A provided but
  // unknown task is always a mismatch and follows onMismatch at the caller.
  res.canRegister = !!res.agentId && !res.hadMismatch;
  return res;
}
