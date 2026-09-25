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
): PresetResolution {
  const res: PresetResolution = { canRegister: false, hadMismatch: false };
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
    // A stale/unknown task_id does NOT flip hadMismatch: task_id is an
    // optional business dimension in the kernel (isolation.ts: "taskId is
    // an optional business dimension for L0/L1 filtering"). An absent or
    // stale task must not block registration — it just means recall is
    // broadened across all of the agent's memories. Only an unknown team or
    // unknown agent is a real identity mismatch (they're the mandatory
    // dimensions); a task mismatch is silently dropped with a caller-side
    // warning instead. See PR feat/task-optional-memory.
  }

  // team + agent resolved → register directly. task_id is OPTIONAL: a
  // missing/stale task yields undefined taskId (broad recall), not a block.
  // This matches the kernel's own semantics and the interactive "本次不关联
  // 任务" / defaultTaskId path.
  res.canRegister = !!res.agentId && !res.hadMismatch;
  return res;
}
