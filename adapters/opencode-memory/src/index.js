/**
 * OpenCode adapter for TencentDB Agent Memory.
 *
 * What it does
 * - On `session.idle`, reads the finished session transcript via the official
 *   OpenCode SDK (`client.session.messages`) and persists it to the Memory
 *   Gateway as an L0 conversation.
 * - Exposes a `memory_search` tool so the agent can recall persistent memories
 *   mid-session (pull-based recall: the agent decides when context is needed).
 *
 * Design decisions
 * - Zero dependencies: no build step, no transitive packages. The plugin is a
 *   single auditable ESM file that runs on any Node >= 18 runtime.
 * - Never writes placeholder data: if the transcript cannot be read, capture is
 *   skipped with a warning instead of polluting memory with garbage.
 * - Deduplicated turns: the same completed turn is only persisted once, even if
 *   `session.idle` fires repeatedly.
 * - Bounded failure: every gateway call has a timeout and a single retry for
 *   transient failures; the v3 envelope `{code, message, data}` is validated.
 *
 * Gateway
 * - Default endpoint: http://127.0.0.1:8420 (the memory-tencentdb Gateway sidecar).
 * - Override with the OPCODE_MEMORY_GATEWAY_URL environment variable.
 * - Tenancy is supplied per request: team_id / agent_id / user_id go in the body,
 *   while x-tdai-service-id goes in the header. `service_id` is an independent
 *   setting (default "default"), overridable via OPCODE_MEMORY_SERVICE_ID — it is
 *   NOT the same as agentId.
 * - API contract follows MemoryTencentdbSdkClient (MemoryCore/hermes-plugin/memory/memory_tencentdb/client.py):
 *   POST /v3/conversation/add and POST /v3/atomic/search.
 */

const DEFAULTS = {
  gatewayUrl: "http://127.0.0.1:8420",
  apiKey: "local",
  teamId: "default",
  agentId: "opencode",
  serviceId: "default",
  userId: "default",
  timeoutMs: 10_000,
  captureRetries: 1,
  maxTranscriptMessages: 20,
  maxSearchResults: 5,
  maxSearchChars: 6_000,
  capturedTurnsCap: 200,
};

/** Build the adapter configuration from environment variables. */
export function loadConfig(env = process.env) {
  const timeoutMs = Number(env.OPCODE_MEMORY_TIMEOUT_MS ?? DEFAULTS.timeoutMs);
  return {
    gatewayUrl: env.OPCODE_MEMORY_GATEWAY_URL || DEFAULTS.gatewayUrl,
    apiKey: env.OPCODE_MEMORY_API_KEY || DEFAULTS.apiKey,
    teamId: env.OPCODE_MEMORY_TEAM_ID || DEFAULTS.teamId,
    agentId: env.OPCODE_MEMORY_AGENT_ID || DEFAULTS.agentId,
    serviceId: env.OPCODE_MEMORY_SERVICE_ID || DEFAULTS.serviceId,
    userId: env.OPCODE_MEMORY_USER_ID || DEFAULTS.userId,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULTS.timeoutMs,
    captureRetries: DEFAULTS.captureRetries,
    maxTranscriptMessages: DEFAULTS.maxTranscriptMessages,
    maxSearchResults: DEFAULTS.maxSearchResults,
    maxSearchChars: DEFAULTS.maxSearchChars,
  };
}

/** Join the text parts of one OpenCode message into a single string. */
export function textFromParts(parts = []) {
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim().length > 0)
    .map((p) => p.text)
    .join("\n");
}

/**
 * Map OpenCode session messages (from `client.session.messages`) to the
 * gateway transcript shape. Only user/assistant messages with text survive;
 * tool calls, system noise and empty messages are dropped.
 */
export function transcriptFromMessages(messages = []) {
  const now = Math.floor(Date.now() / 1000);
  const transcript = [];
  for (const message of messages) {
    const role = message?.info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = textFromParts(message.parts);
    if (!content) continue;
    const created = message?.info?.time?.created;
    transcript.push({
      role,
      content,
      timestamp: typeof created === "number" ? created : now,
    });
  }
  return transcript;
}

/** Stable dedup key for one completed turn, based on the last message id. */
function turnKey(sessionID, messages, transcript) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i]?.info?.id;
    if (id) return `${sessionID}:${id}`;
  }
  const last = transcript.at(-1)?.content ?? "";
  let hash = 0;
  for (const char of last) hash = (hash * 31 + char.codePointAt(0)) | 0;
  return `${sessionID}:${hash}:${transcript.length}`;
}

/**
 * POST to the Memory Gateway with timeout + retry, and validate the v3
 * envelope. A non-zero `code` is treated as a failure so the agent sees the
 * error instead of silently reading a successful-looking response.
 */
export async function gateway(cfg, path, body, { retries = 0 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const response = await fetch(`${cfg.gatewayUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
          "x-tdai-service-id": cfg.serviceId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      const envelope = JSON.parse(text || "{}");
      if (typeof envelope.code === "number" && envelope.code !== 0 && envelope.code !== 200) {
        throw new Error(`gateway ${path} error ${envelope.code}: ${envelope.message ?? "unknown"}`);
      }
      return envelope.data ?? envelope;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/** Format memory_search results as readable text for the agent. */
export function formatSearchResults(data, maxChars = DEFAULTS.maxSearchChars) {
  let output;
  if (Array.isArray(data)) {
    if (data.length === 0) output = "No memories found.";
    else {
      output = data
        .map((item, index) => {
          if (typeof item === "string") return `${index + 1}. ${item}`;
          const content = item?.content ?? item?.text ?? JSON.stringify(item);
          const score = typeof item?.score === "number" ? ` [score=${item.score.toFixed(3)}]` : "";
          return `${index + 1}.${score} ${content}`;
        })
        .join("\n");
    }
  } else {
    output = JSON.stringify(data, null, 2);
  }
  return output.length > maxChars ? `${output.slice(0, maxChars)}\n… (truncated)` : output;
}

const capturedTurns = new Set();

/** Persist one finished session's transcript as an L0 conversation. */
async function captureSession(ctx, cfg, sessionID) {
  let messages = [];
  try {
    // Official OpenCode SDK: list the session's messages after it went idle.
    const response = await ctx.client.session.messages({ path: { id: sessionID } });
    messages = response?.data ?? [];
  } catch (error) {
    console.warn(`[opencode-memory] could not read session ${sessionID}, skipping capture: ${error?.message}`);
    return;
  }

  const transcript = transcriptFromMessages(messages).slice(-cfg.maxTranscriptMessages);
  if (transcript.length === 0) return;

  const key = turnKey(sessionID, messages, transcript);
  if (capturedTurns.has(key)) return;
  capturedTurns.add(key);
  if (capturedTurns.size > DEFAULTS.capturedTurnsCap) {
    capturedTurns.delete(capturedTurns.values().next().value);
  }

  await gateway(
    cfg,
    "/v3/conversation/add",
    {
      team_id: cfg.teamId,
      agent_id: cfg.agentId,
      user_id: cfg.userId,
      session_id: sessionID,
      messages: transcript,
    },
    { retries: cfg.captureRetries },
  );
}

/** Plugin factory: inject ctx/env for testability. */
export function createMemoryPlugin(ctx, env = process.env) {
  const cfg = loadConfig(env);
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle" && event.properties?.sessionID) {
        await captureSession(ctx, cfg, event.properties.sessionID);
      }
    },
    tool: {
      memory_search: {
        description:
          "Search persistent memories from TencentDB Agent Memory. " +
          "Use this when you need facts, numbers or decisions from earlier sessions " +
          "instead of asking the user again.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search keywords, e.g. '招商银行 净息差'" },
            limit: { type: "number", description: "Max results (default 5)" },
          },
          required: ["query"],
        },
        execute: async ({ query, limit }) => {
          const data = await gateway(cfg, "/v3/atomic/search", {
            team_id: cfg.teamId,
            agent_id: cfg.agentId,
            user_id: cfg.userId,
            query,
            limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : cfg.maxSearchResults,
          });
          return formatSearchResults(data, cfg.maxSearchChars);
        },
      },
    },
  };
}

export const memoryPlugin = (ctx) => createMemoryPlugin(ctx, process.env);

export default memoryPlugin;
