import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TDAMError } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { createClients } from "./clients.js";
import type { AdapterStatus, ConfigResult, LoadedConfig } from "./types.js";

const SKILL_PENDING_DIRECTORY = "tdai-memory-skills";

export function maskId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

async function findPageItem<T>(
  loadPage: (offset: number) => Promise<{ items: T[]; total: number }>,
  matches: (item: T) => boolean,
): Promise<T | undefined> {
  const pageSize = 100;
  for (let offset = 0; offset < 10_000; offset += pageSize) {
    const page = await loadPage(offset);
    const match = page.items.find(matches);
    if (match) return match;
    if (page.items.length < pageSize || offset + page.items.length >= page.total) return undefined;
  }
  return undefined;
}

/**
 * Local view of the Skill pipeline: how many captured turns are still awaiting
 * delivery (`pending`), which of those hit an ambiguous failure and are marked
 * `uncertain` (never auto-retried), and how many were quarantined as `dead`.
 * Pure filesystem scan; skipped entirely when skills are disabled.
 */
async function skillPipelineState(config: LoadedConfig): Promise<string | undefined> {
  if (!config.skills.enabled) return undefined;
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const directory = join(getAgentDir(), SKILL_PENDING_DIRECTORY);
  let pending = 0;
  let uncertain = 0;
  let dead = 0;
  try {
    const entries = await readdir(directory);
    for (const name of entries) {
      if (name.endsWith(".json.dead")) {
        dead += 1;
        continue;
      }
      if (name.endsWith(".json")) {
        pending += 1;
        try {
          const record = JSON.parse(await readFile(join(directory, name), "utf8")) as { uncertain?: boolean };
          if (record.uncertain === true) uncertain += 1;
        } catch {
          // unreadable record still counts as pending
        }
      }
    }
  } catch {
    // directory does not exist yet — nothing has been queued
  }
  const labels = [`pending ${pending}`, `uncertain ${uncertain}`, `dead ${dead}`];
  return `Skills: on · ${labels.join(" · ")} (run /tdai-memory-sync-skills to pull learned skills into Pi)`;
}

export function classifyError(error: unknown): AdapterStatus {
  if (error instanceof TDAMError) {
    const auth = error.code === 401 || error.code === 403 || error.code === 40101 || error.code === 40301;
    return {
      kind: auth ? "auth-error" : "error",
      summary: auth ? "memory: auth error" : "memory: server error",
      details: [`Memory returned code ${error.code}`, error.message],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const offline = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|aborted/i.test(message);
  return {
    kind: offline ? "offline" : "error",
    summary: offline ? "memory: offline" : "memory: error",
    details: [message],
  };
}

export async function checkStatus(
  result: ConfigResult,
  onProgress: (phase: string) => void = () => undefined,
): Promise<AdapterStatus> {
  if (!result.ok) {
    return { kind: "config-error", summary: "memory: config error", details: result.errors };
  }
  const config = result.config;
  if (!config.enabled) {
    return { kind: "disabled", summary: "memory: disabled", details: ["Adapter is disabled by configuration"] };
  }

  try {
    const clients = createClients(config);
    onProgress("auth");
    const verification = await clients.metadata.verifyAuth(config.userKey);
    if (!verification.valid || !verification.user) {
      return { kind: "auth-error", summary: "memory: auth error", details: ["user_key verification failed"] };
    }
    if (verification.user.user_id !== config.userId) {
      return {
        kind: "auth-error",
        summary: "memory: identity mismatch",
        details: [
          `Configured user ${maskId(config.userId)} does not match verified user ${maskId(verification.user.user_id)}`,
        ],
      };
    }

    onProgress("team");
    const team = await findPageItem(
      (offset) => clients.metadata.listTeams({ user_id: config.userId, limit: 100, offset }),
      (item) => item.team_id === config.teamId,
    );
    if (!team) {
      return {
        kind: "auth-error",
        summary: "memory: team unavailable",
        details: [`Configured team ${maskId(config.teamId)} is not accessible to this user`],
      };
    }
    onProgress("agent");
    const agent = await findPageItem(
      (offset) => clients.metadata.listAgents({ team_id: config.teamId, limit: 100, offset }),
      (item) => item.agent_id === config.agentId,
    );
    if (!agent) {
      return {
        kind: "auth-error",
        summary: "memory: agent unavailable",
        details: [`Configured agent ${maskId(config.agentId)} is not accessible in team ${maskId(config.teamId)}`],
      };
    }

    onProgress("data");
    const l0 = await clients.memory.queryConversation({ limit: 1, offset: 0 });
    const details = [
      `Endpoint: ${new URL(config.endpoint).origin}`,
      `User: ${verification.user.username} (${maskId(config.userId)})`,
      `Team: ${team.name} (${maskId(config.teamId)})`,
      `Agent: ${agent.name} (${maskId(config.agentId)})`,
      `User key source: ${config.userKeySource}`,
      `Gateway key source: ${config.gatewayApiKeySource}`,
    ];
    const hasMemory = (l0.total ?? 0) > 0;
    details.push(
      hasMemory
        ? `Memory: has L0 history — recall will surface earlier conversations on related questions`
        : `Memory: no conversations yet — finish a few sessions and recall will kick in`,
    );
    const skillsLine = await skillPipelineState(config);
    if (skillsLine) details.push(skillsLine);
    if (!config.rejectUnauthorized) details.push("WARNING: TLS certificate verification is disabled");
    return {
      kind: "ready",
      summary: "memory: ready",
      details,
    };
  } catch (error) {
    return classifyError(error);
  }
}

export function formatStatus(status: AdapterStatus): string {
  return [status.summary, ...status.details.map((line) => `- ${line}`)].join("\n");
}
