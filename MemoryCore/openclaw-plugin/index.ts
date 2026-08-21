/**
 * memory-tencentdb-client — OpenClaw 记忆插件（v3 客户端）
 *
 * 通过 @tencentdb-agent-memory/memory-sdk-ts-v2 连接远端 Memory Gateway，
 * 使用 /v3/* API 与强制 team/agent/user isolation，
 * 提供四层记忆的自动捕获、召回和工具调用能力。
 *
 * COS 读文件旁路：createMemoryFileReader（/v2/cos/secret + STS），工具 tdai_read_cos。
 * 本插件不包含任何数据处理逻辑（无 VDB/Embedding/Pipeline），也不含 Offload；
 * 所有记忆操作委托给远端 Gateway。
 */

import { MemoryClient, createMemoryFileReader } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { performRecall } from "./src/hooks/recall.js";
import { performCapture } from "./src/hooks/capture.js";
import { handleMemorySearch } from "./src/tools/memory-search.js";
import { handleConversationSearch } from "./src/tools/conversation-search.js";
import { handleReadCos } from "./src/tools/read-cos.js";

const TAG = "[memory-client]";

// ── Config types (matches openclaw.plugin.json configSchema) ──────────
interface ServerConfig {
  url?: string;
  apiKey?: string;
  instanceId?: string;
  teamId?: string;
  agentId?: string;
  userId?: string;
  rejectUnauthorized?: boolean;
  /**
   * Optional per-agent isolation mapping: OpenClaw agent id → memory agentId.
   * When an OpenClaw agent is not present in the mapping, fall back to the
   * global `agentId` value above.
   */
  agentIdMapping?: Record<string, string>;
}
interface RecallConfig {
  maxResults?: number;
  includePersona?: boolean;
  includeSceneNav?: boolean;
}
interface CaptureConfig {
  enabled?: boolean;
  /**
   * Session key glob patterns to exclude from L0 capture ("stealth" sessions).
   * Supports `*` and `?` wildcards, e.g. ["*:incognito-*"].
   */
  excludeSessions?: string[];
  /**
   * Agent id glob patterns to exclude from L0 capture, e.g. ["bench-*"].
   */
  excludeAgents?: string[];
}
interface PluginConfig {
  server?: ServerConfig;
  recall?: RecallConfig;
  capture?: CaptureConfig;
}

// Matches OpenClaw plugin register() signature: export default function register(api)
export default function register(api: any) {
  // ── Read config (nested objects per configSchema) ──────────────────
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const server = cfg.server ?? {};
  const recall = cfg.recall ?? {};
  const capture = cfg.capture ?? {};

  const serverUrl = server.url || "http://127.0.0.1:8420";
  // apiKey may be a literal string, or already the materialized string value of a
  // SecretRef at real gateway startup. Guard against an unresolved SecretRef
  // object reaching register() (e.g. the CLI install-time load has no secrets runtime).
  const apiKey = typeof server.apiKey === "string" ? server.apiKey : "local";
  const instanceId = server.instanceId || "default";
  const teamId = server.teamId || "default";
  const agentId = server.agentId || "default";
  const userId = server.userId || "default";
  const agentIdMapping: Record<string, string> = server.agentIdMapping ?? {};

  // Resolve the memory agentId for an OpenClaw agent: agentIdMapping wins, else
  // fall back to the global `server.agentId`.
  function effectiveAgentFor(openclawAgentId: string | undefined): string {
    return (openclawAgentId && agentIdMapping[openclawAgentId]) || agentId;
  }

  // Return a client scoped to the effective memory agentId for the given OpenClaw
  // agent, falling back to the global `agentId` when the agent is not mapped.
  // Session scoping (when provided) is applied on top.
  function scopedMemoryClient(openclawAgentId: string | undefined, sessionId: string | undefined): MemoryClient {
    const effectiveAgentId = effectiveAgentFor(openclawAgentId);
    const overrides: { agentId?: string; sessionId?: string } = {};
    if (effectiveAgentId !== agentId) overrides.agentId = effectiveAgentId;
    if (sessionId) overrides.sessionId = sessionId;
    return Object.keys(overrides).length > 0 ? client.withIsolation(overrides) : client;
  }

  // toolCallId → effective memory agentId, recorded by before_tool_call (which
  // has ctx.agentId). Tool execute handlers read their own toolCallId to scope.
  const toolCallAgents = new Map<string, string>();

  // Resolve a client scoped to the agent that currently owns the given tool call
  // (as recorded by before_tool_call), falling back to the global agentId.
  function scopedClientForTool(toolCallId: string | undefined): MemoryClient {
    if (!toolCallId) return client;
    const effAgent = toolCallAgents.get(toolCallId);
    if (effAgent && effAgent !== agentId) return client.withIsolation({ agentId: effAgent });
    return client;
  }
  const recallMaxResults = recall.maxResults ?? 5;
  const includePersona = recall.includePersona !== false;
  const includeSceneNav = recall.includeSceneNav !== false;
  const captureEnabled = capture.enabled !== false;
  const rejectUnauthorized = server.rejectUnauthorized !== false;
  const excludeSessions: string[] = capture.excludeSessions ?? [];
  const excludeAgents: string[] = capture.excludeAgents ?? [];

  // Simple glob match supporting * and ? wildcards.
  function globMatch(pattern: string, value: string): boolean {
    if (pattern === "*") return true;
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`).test(value);
  }

  // "Stealth" filter: sessions/agents matching the exclusion lists are never
  // captured to L0 (and their prompts are not cached at before_prompt_build).
  function shouldSkipCapture(sessionKey: string | undefined, agentId: string | undefined): boolean {
    if (sessionKey && excludeSessions.some((p) => globMatch(p, sessionKey))) return true;
    if (agentId && excludeAgents.some((p) => globMatch(p, agentId))) return true;
    return false;
  }

  // ── Initialize v3 SDK ──
  // Isolation (team/agent/user) is required by Gateway /v3/*; sessionId may be
  // narrowed per-hook via client.withIsolation({ sessionId }).
  const client = new MemoryClient({
    endpoint: serverUrl,
    apiKey,
    serviceId: instanceId,
    teamId,
    agentId,
    userId,
    rejectUnauthorized,
  });

  // COS STS 旁路；无独立配置块。
  // STS 凭证仍走 POST /v2/cos/secret，鉴权复用 server.apiKey / instanceId。
  const fileReader = createMemoryFileReader({
    endpoint: serverUrl,
    apiKey,
    serviceId: instanceId,
  });

  api.logger.info?.(
    `${TAG} Initialized: server=${serverUrl}, instance=${instanceId}, ` +
    `isolation(team=${teamId},agent=${agentId},user=${userId}), ` +
    `recall(persona=${includePersona},sceneNav=${includeSceneNav},max=${recallMaxResults}), ` +
    `capture=${captureEnabled}, cosRead=on, rejectUnauthorized=${rejectUnauthorized}`,
  );

  // ── Register Tools (same pattern as extensions/memory-tencentdb/index.ts) ──

  api.registerTool(
    {
      name: "tdai_memory_search",
      label: "Memory Search",
      description:
        "Search structured memories (L1). Returns relevant memory fragments about " +
        "user preferences, past events, rules, and facts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text (natural language)." },
          limit: { type: "number", description: "Max results to return (default: 5)." },
          type: { type: "string", description: "Filter by memory type." },
        },
        required: ["query"],
      },
      async execute(toolCallId: string, params: Record<string, unknown>) {
        return handleMemorySearch(scopedClientForTool(toolCallId), params as any, api.logger);
      },
    },
    { name: "tdai_memory_search" },
  );

  api.registerTool(
    {
      name: "tdai_conversation_search",
      label: "Conversation Search",
      description:
        "Search raw conversation history (L0). Returns original messages with timestamps.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text." },
          limit: { type: "number", description: "Max results (default: 5)." },
          session_key: { type: "string", description: "Filter by session ID." },
        },
        required: ["query"],
      },
      async execute(toolCallId: string, params: Record<string, unknown>) {
        return handleConversationSearch(scopedClientForTool(toolCallId), params as any, api.logger);
      },
    },
    { name: "tdai_conversation_search" },
  );

  api.registerTool(
    {
      name: "tdai_read_cos",
      label: "Read Memory File",
      description:
        "Read a memory pipeline file from object storage by relative path " +
        "(e.g. Scene Navigation paths like 'scene_blocks/xxx.md', or 'persona.md'). " +
        "Uses STS credentials from the Memory Gateway.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Full relative storage key (e.g. 'scene_blocks/travel-plan.md' or 'persona.md').",
          },
        },
        required: ["path"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        return handleReadCos(fileReader, params as any, api.logger);
      },
    },
    { name: "tdai_read_cos" },
  );

  // ── Register Hooks (api.on pattern, same as memory-tencentdb) ──

  // Per-session caches:
  //   - pendingOriginalPrompts: clean user prompt + messageCount captured at
  //     before_prompt_build, used at agent_end to (a) replace polluted user
  //     message and (b) position-slice this turn's new messages.
  //   - sessionCursors: max timestamp of last captured batch — used as a
  //     fallback when the position slice cannot be determined.
  const pendingOriginalPrompts = new Map<string, { text: string; messageCount: number }>();
  const sessionCursors = new Map<string, number>();

  api.on("before_prompt_build", async (event: any, ctx: any) => {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return;

    const userText = event?.prompt;
    if (!userText) return;

    // Cache original prompt for agent_end (only if capture is enabled AND the
    // session is not stealth-excluded — it is the only consumer; recall doesn't
    // need this data).
    if (captureEnabled && !shouldSkipCapture(sessionKey, ctx?.agentId)) {
      const messageCount = Array.isArray(event?.messages) ? event.messages.length : 0;
      pendingOriginalPrompts.set(sessionKey, { text: userText, messageCount });
    }

    try {
      // Scope recall to this OpenClaw agent (via agentIdMapping, fallback to
      // global agentId) and session when available.
      const sessionClient = scopedMemoryClient(ctx?.agentId, ctx?.sessionId);

      const result = await performRecall(sessionClient, {
        query: userText,
        maxResults: recallMaxResults,
        includePersona,
        includeSceneNav,
      }, api.logger);

      // OpenClaw consumes the *return value* of before_prompt_build,
      // not mutations on the event object. Map our RecallResult to the
      // PluginHookBeforePromptBuildResult shape.
      const out: { prependContext?: string; appendSystemContext?: string } = {};
      if (result.prependContext) out.prependContext = result.prependContext;
      if (result.appendSystemContext) out.appendSystemContext = result.appendSystemContext;
      return out;
    } catch (err) {
      api.logger.warn(`${TAG} [recall] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  if (captureEnabled) {
    api.logger.info?.(`${TAG} Registering agent_end hook for auto-capture`);
    api.on("agent_end", async (event: any, ctx: any) => {
      const startMs = Date.now();
      const sessionKey = ctx?.sessionKey;
      const messages = (event?.messages ?? []) as unknown[];

      api.logger.debug?.(
        `${TAG} [agent_end] hook triggered: success=${event?.success}, ` +
        `messages=${messages.length}, sessionKey=${sessionKey ?? "(none)"}`,
      );

      // Skip on agent failure — partial / errored turns shouldn't pollute L0.
      if (event?.success === false) {
        api.logger.info(`${TAG} [agent_end] agent did not succeed, skip capture`);
        return;
      }

      if (!sessionKey) {
        api.logger.warn(`${TAG} [agent_end] no sessionKey in ctx, skip capture`);
        return;
      }
      if (messages.length === 0) {
        api.logger.debug?.(`${TAG} [agent_end] event.messages is empty, skip capture`);
        return;
      }

      // Stealth sessions/agents are never written to L0.
      if (shouldSkipCapture(sessionKey, ctx?.agentId)) {
        api.logger.info(
          `${TAG} [agent_end] session matches excludeSessions/excludeAgents, skip capture`,
        );
        return;
      }

      const cached = pendingOriginalPrompts.get(sessionKey);
      // Don't delete on read — keep until we successfully send (in case of retry),
      // or let it be overwritten on next before_prompt_build.

      try {
        // Scope capture to this OpenClaw agent (via agentIdMapping, fallback to
        // global agentId) and session when available.
        const sessionClient = scopedMemoryClient(ctx?.agentId, ctx?.sessionId);

        const result = await performCapture(
          sessionClient,
          {
            sessionKey,
            sessionId: ctx?.sessionId,
            rawMessages: messages,
            originalUserText: cached?.text,
            originalUserMessageCount: cached?.messageCount,
            afterTimestamp: sessionCursors.get(sessionKey),
          },
          api.logger,
        );

        if (result.maxTimestamp) {
          sessionCursors.set(sessionKey, result.maxTimestamp);
        }
        // Cached prompt has been used — clear it so a stale value doesn't
        // bleed into the next turn (e.g. after agent restart).
        pendingOriginalPrompts.delete(sessionKey);

        const elapsed = Date.now() - startMs;
        api.logger.info(
          `${TAG} [agent_end] capture done in ${elapsed}ms ` +
          `(captured=${result.capturedCount}, serverTotal=${result.serverTotalCount ?? "?"})`,
        );
      } catch (err) {
        const elapsed = Date.now() - startMs;
        api.logger.warn(
          `${TAG} [capture] Failed after ${elapsed}ms: ` +
          (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  } else {
    api.logger.info?.(`${TAG} capture disabled by config`);
  }

  // ── Per-agent tool scoping ─────────────────────────────────────────────
  // OpenClaw does not surface the running agent to plugin tool `execute`
  // handlers directly, so before_tool_call (which DOES receive ctx.agentId)
  // records the effective agent keyed by toolCallId. The tool handlers read it
  // via scopedClientForTool(...) to apply withIsolation({ agentId }). Fallback
  // to the global agentId when not recorded.
  api.on(
    "before_tool_call",
    (event: any, ctx: any) => {
      const effAgent = effectiveAgentFor(ctx?.agentId);
      if (event?.toolCallId) toolCallAgents.set(event.toolCallId, effAgent);
    },
    { matcher: ["tdai_memory_search", "tdai_conversation_search", "tdai_read_cos"] },
  );
}
