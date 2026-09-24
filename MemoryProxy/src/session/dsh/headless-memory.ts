import type { MetadataClient } from "../../meta/client.js";
import type { SessionInitConfig } from "../../types.js";
import { buildSessionInfo } from "../registrar.js";
import { parsePresetIdentity } from "../preset.js";
import type { SessionInfo } from "../types.js";

export interface DshHeadlessMemoryIdentityInput {
  config: SessionInitConfig;
  headers: Record<string, string>;
  metadataClient: MetadataClient;
  userId: string;
  userKey?: string;
  sessionKey: string;
  spaceId?: string;
}

/**
 * Resolve a memory-only identity for headless DSH without entering the
 * interactive session-init state machine. Every request is validated against
 * the authenticated user's current team and agent visibility.
 */
export async function resolveDshHeadlessMemoryIdentity(
  input: DshHeadlessMemoryIdentityInput,
): Promise<SessionInfo | null> {
  if (!input.config.enabled) return null;

  const preset = parsePresetIdentity(input.config, input.headers);
  if (!preset?.teamId || !preset.agentId) return null;

  const teams = await input.metadataClient.listTeams(input.userId);
  if (!teams.some((team) => team.team_id === preset.teamId)) return null;

  const agents = await input.metadataClient.listAgents(preset.teamId, input.userId);
  if (!agents.some((agent) => agent.agent_id === preset.agentId)) return null;

  let taskId: string | undefined;
  if (preset.taskId) {
    const tasks = await input.metadataClient.listTasks(preset.teamId);
    if (tasks.some((task) => task.task_id === preset.taskId)) {
      taskId = preset.taskId;
    }
  }

  return buildSessionInfo(
    {
      session_id: input.sessionKey,
      team_id: preset.teamId,
      agent_id: preset.agentId,
      task_id: taskId,
      user_id: input.userId,
    },
    input.userKey,
    input.spaceId,
  );
}
