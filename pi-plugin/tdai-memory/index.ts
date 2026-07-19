/**
 * TencentDB Agent Memory — Pi coding agent adapter.
 *
 * A Pi extension (https://github.com/earendil-works/pi) that connects Pi to
 * the TDAI Memory Gateway, giving Pi persistent cross-session memory:
 *
 * - **Recall** (`before_agent_start` → POST /recall): before each agent run,
 *   memories relevant to the user prompt are fetched and injected into the
 *   LLM context as a custom message.
 * - **Capture** (`agent_end` → POST /capture): after each agent run, the
 *   user/assistant round is sent to the Gateway, which archives it (L0) and
 *   schedules structured fact extraction (L1) asynchronously.
 * - **Session end** (`session_shutdown` → POST /session/end): flushes any
 *   pending pipeline work when Pi exits or switches sessions.
 * - **Explicit search** (`memory_search` tool → POST /search/memories): the
 *   LLM can proactively search long-term memories on demand.
 *
 * Lifecycle mapping (Pi ⇄ Gateway):
 *
 *   session_start        → derive stable session_key from Pi's session id
 *   before_agent_start   → /recall (inject context)
 *   agent_end            → /capture (user + assistant round)
 *   session_shutdown     → /session/end
 *   memory_search (tool) → /search/memories
 *
 * Configuration (environment variables):
 *
 *   MEMORY_TENCENTDB_GATEWAY_URL      Gateway base URL (default: http://127.0.0.1:8420)
 *   MEMORY_TENCENTDB_GATEWAY_API_KEY  Bearer token, when the Gateway sets TDAI_GATEWAY_API_KEY
 *   MEMORY_TENCENTDB_TIMEOUT_MS       Per-request timeout (default: 5000)
 *   MEMORY_TENCENTDB_RECALL_DISPLAY   "1"/"true" to show recalled memories in the TUI
 *                                     (default: hidden — context-only injection)
 *
 * Fault tolerance: every Gateway call is best-effort. When the Gateway is
 * unreachable, Pi keeps working without memory — recall injection is
 * skipped, capture is dropped, and the `memory_search` tool reports the
 * outage to the LLM instead of throwing.
 *
 * Install: copy this directory to `~/.pi/agent/extensions/tdai-memory/`
 * (global) or `.pi/extensions/tdai-memory/` (project), or test with
 * `pi -e ./pi-plugin/tdai-memory/index.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GatewayClient } from "./gateway-client.js";
import { extractRound } from "./capture-utils.js";

const CUSTOM_MESSAGE_TYPE = "tdai-memory-recall";

// ============================
// Config
// ============================

function readConfig() {
  const env = process.env;
  const flag = (v: string | undefined) =>
    v !== undefined && ["1", "true", "yes"].includes(v.toLowerCase());
  const timeoutRaw = Number.parseInt(env.MEMORY_TENCENTDB_TIMEOUT_MS ?? "", 10);
  return {
    gatewayUrl: env.MEMORY_TENCENTDB_GATEWAY_URL?.trim() || "http://127.0.0.1:8420",
    apiKey: env.MEMORY_TENCENTDB_GATEWAY_API_KEY?.trim() || undefined,
    timeoutMs: Number.isFinite(timeoutRaw) ? timeoutRaw : 5000,
    displayRecall: flag(env.MEMORY_TENCENTDB_RECALL_DISPLAY),
  };
}

// ============================
// Extension
// ============================

export default function tdaiMemoryExtension(pi: ExtensionAPI) {
  const config = readConfig();

  let sessionKey = `pi_${Date.now()}`;
  let gatewayWarned = false;

  const client = new GatewayClient({
    baseUrl: config.gatewayUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });

  pi.on("session_start", async (_event, ctx) => {
    // Pi session ids are stable across resume/fork of the same session file,
    // which is exactly the "conversation identity" the Gateway expects.
    sessionKey = `pi_${ctx.sessionManager.getSessionId()}`;
    gatewayWarned = false;
  });

  // ── Recall: inject relevant memories before each agent run ──
  pi.on("before_agent_start", async (event, ctx) => {
    const recall = await client.recall(event.prompt, sessionKey, ctx.signal);
    if (recall === null) {
      // Gateway unreachable — warn once per session, then degrade silently.
      if (!gatewayWarned && ctx.hasUI) {
        ctx.ui.notify(
          `tdai-memory: Gateway unreachable at ${config.gatewayUrl} — running without memory`,
          "warning",
        );
        gatewayWarned = true;
      }
      return;
    }
    if (!recall.context) return;

    return {
      message: {
        customType: CUSTOM_MESSAGE_TYPE,
        content:
          "[TencentDB Agent Memory — recalled context]\n" +
          "The following long-term memories about this user/project may be relevant. " +
          "Treat them as background knowledge from earlier sessions; the current " +
          "conversation always takes precedence when they conflict.\n\n" +
          recall.context,
        display: config.displayRecall,
      },
    };
  });

  // ── Capture: archive the round after each agent run ──
  pi.on("agent_end", async (event, ctx) => {
    const { userContent, assistantContent } = extractRound(
      event.messages as Array<{ role?: string; content?: unknown }>,
    );
    if (!userContent || !assistantContent) return;

    const result = await client.capture(userContent, assistantContent, sessionKey);
    if (result && ctx.hasUI) {
      ctx.ui.setStatus("tdai-memory", `memory: captured (L0 ${result.l0_recorded})`);
    }
  });

  // ── Session end: flush pending pipeline work ──
  pi.on("session_shutdown", async () => {
    await client.sessionEnd(sessionKey);
  });

  // ── Explicit search tool for the LLM ──
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search the user's long-term memories (facts, preferences, past decisions " +
      "from earlier sessions) stored in TencentDB Agent Memory. Use when the user " +
      "refers to something from a previous conversation or when past context would help.",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords or a question to search memories for" }),
      limit: Type.Optional(
        Type.Number({ description: "Maximum memories to return (default 5)" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await client.searchMemories(
        params.query,
        params.limit,
        signal ?? undefined,
      );
      if (result === null) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Memory gateway unreachable at ${config.gatewayUrl}; memory search unavailable.`,
            },
          ],
          isError: true,
          details: {},
        };
      }
      return {
        content: [{ type: "text" as const, text: result.results }],
        details: { total: result.total, strategy: result.strategy },
      };
    },
  });
}
