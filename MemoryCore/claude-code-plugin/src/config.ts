/**
 * Plugin configuration, read from environment variables.
 *
 * Claude Code runs every hook as a fresh process and starts the MCP server
 * once per session, so the environment is the only configuration channel
 * both share. Defaults match the OpenClaw client adapter: a local standalone
 * Gateway with the `default` isolation triple.
 */

import os from "node:os";
import path from "node:path";

export interface PluginConfig {
  /** Memory Gateway base URL. */
  gatewayUrl: string;
  /** Bearer token for the Gateway (`x-tdai-user-key`). */
  gatewayApiKey: string;
  /** Memory instance id (`x-tdai-service-id`). */
  serviceId: string;
  /** v3 isolation triple. */
  teamId: string;
  agentId: string;
  userId: string;
  /** Knowledge Service (wiki) base URL; wiki tools are registered when set. */
  knowledgeUrl?: string;
  knowledgeApiKey?: string;
  /** Where hook processes share prompt cache and capture markers. */
  stateDir: string;
  /** Recall: L1 hits per prompt; persona and scene navigation once per session. */
  recallMaxResults: number;
  recallIncludePersona: boolean;
  recallIncludeSceneNav: boolean;
  /** Capture: on by default; `TDAI_CAPTURE=off` disables. */
  captureEnabled: boolean;
  /** Wall-clock budgets for the transcript batches at Stop and SessionEnd. */
  stopBudgetMs: number;
  sessionEndBudgetMs: number;
  /** Gateway timeout for one capture batch. */
  captureTimeoutMs: number;
  /** Gateway timeout for recall calls (must fit the UserPromptSubmit hook timeout). */
  recallTimeoutMs: number;
}

function off(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.MEMORY_TENCENTDB_ROOT
    ?? path.join(env.HOME ?? env.USERPROFILE ?? os.tmpdir(), ".memory-tencentdb");
  return env.TDAI_CLAUDE_CODE_STATE_DIR ?? path.join(root, "claude-code-plugin");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PluginConfig {
  return {
    gatewayUrl: (env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420").replace(/\/+$/, ""),
    gatewayApiKey: env.TDAI_GATEWAY_API_KEY ?? env.TDAI_API_KEY ?? "local",
    serviceId: env.TDAI_SERVICE_ID ?? env.TDAI_INSTANCE_ID ?? "default",
    teamId: env.TDAI_TEAM_ID ?? "default",
    agentId: env.TDAI_AGENT_ID ?? "default",
    userId: env.TDAI_USER_ID ?? "default",
    knowledgeUrl: env.TDAI_KNOWLEDGE_URL ? env.TDAI_KNOWLEDGE_URL.replace(/\/+$/, "") : undefined,
    knowledgeApiKey: env.TDAI_KNOWLEDGE_API_KEY ?? env.TDAI_GATEWAY_API_KEY ?? env.TDAI_API_KEY,
    stateDir: defaultStateDir(env),
    recallMaxResults: integer(env.TDAI_RECALL_MAX_RESULTS, 5),
    recallIncludePersona: !off(env.TDAI_RECALL_PERSONA),
    recallIncludeSceneNav: !off(env.TDAI_RECALL_SCENE_NAV),
    captureEnabled: !off(env.TDAI_CAPTURE),
    stopBudgetMs: integer(env.TDAI_STOP_BUDGET_MS, 3_500),
    sessionEndBudgetMs: integer(env.TDAI_SESSION_END_BUDGET_MS, 25_000),
    captureTimeoutMs: integer(env.TDAI_CAPTURE_TIMEOUT_MS, 15_000),
    recallTimeoutMs: integer(env.TDAI_RECALL_TIMEOUT_MS, 3_000),
  };
}
