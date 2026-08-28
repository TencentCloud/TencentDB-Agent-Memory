#!/usr/bin/env node
/**
 * TencentDB Agent Memory — OpenCode MCP Adapter
 *
 * A lightweight MCP stdio server that exposes TencentDB Agent Memory
 * search/recall tools to OpenCode via the Model Context Protocol (MCP).
 *
 * How it works:
 *   OpenCode <--stdio--> this server <--HTTP--> TencentDB v3 Gateway
 *
 * Tools exposed:
 *   - tdai_memory_search        Search atomic L1/L2 long-term memory (/v3/atomic/search)
 *   - tdai_conversation_search  Search raw conversation history (/v3/conversation/search)
 *
 * Note: This adapter provides explicit recall tools via MCP. It does not
 * automatically hook OpenCode session lifecycle events or perform background
 * transcript capture.
 *
 * Related:
 *   - Issue #926: https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/926
 *   - OpenCode MCP docs: https://opencode.ai/docs/mcp-servers
 *   - MCP spec: https://modelcontextprotocol.io
 */

// ── Config ────────────────────────────────────────────────────────────────────

const GATEWAY_URL  = (process.env.TDAI_GATEWAY_URL ?? "http://localhost:8420").replace(/\/$/, "");
const API_KEY      = process.env.TDAI_MEMORY_API_KEY ?? process.env.TDAI_ADMIN_KEY ?? process.env.TDAI_API_KEY ?? "";
const SERVICE_ID   = process.env.TDAI_MEMORY_SERVICE_ID ?? process.env.TDAI_SERVICE_ID ?? "default";
const AGENT_ID     = process.env.TDAI_AGENT_ID  ?? "opencode";
const TEAM_ID      = process.env.TDAI_TEAM_ID   ?? "default";
const USER_ID      = process.env.TDAI_USER_ID   ?? "default";
const TASK_ID      = process.env.TDAI_TASK_ID   ?? undefined;
const RECALL_LIMIT = parseInt(process.env.TDAI_RECALL_LIMIT ?? "5", 10);
const TIMEOUT_MS   = parseInt(process.env.TDAI_TIMEOUT_MS   ?? "5000", 10);

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "tdai_memory_search",
    description:
      "Search TencentDB Agent Memory for relevant atomic memory records (L1/L2), " +
      "user preferences, project context, and past decisions. Use this before starting " +
      "any task to recall what the agent already knows.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language query describing what you want to recall.",
        },
        limit: {
          type: "number",
          description: `Max number of memory items to return (default: ${RECALL_LIMIT}).`,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "tdai_conversation_search",
    description:
      "Search raw conversation history stored in TencentDB Agent Memory (L0). " +
      "Use when you need to find what was discussed in a specific past session " +
      "or verify earlier instructions.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords or phrase to search for in past conversations.",
        },
        limit: {
          type: "number",
          description: `Max number of conversation excerpts to return (default: ${RECALL_LIMIT}).`,
        },
      },
      required: ["query"],
    },
  },
];

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Makes an HTTP POST request to the TencentDB v3 gateway.
 * Conforms to the v3 gateway contract:
 *   - Headers: Authorization (Bearer token), x-tdai-service-id
 *   - Body: tenant isolation fields (team_id, agent_id, user_id, task_id) in snake_case
 *
 * Fail-open: returns { items: [], error: <reason> } on any network / gateway error
 * so OpenCode never crashes due to a memory lookup failure.
 *
 * @param {string} path  - API path, e.g. "/v3/atomic/search"
 * @param {object} payload - query parameters to merge with tenant context
 * @returns {Promise<object>} Parsed JSON response or error envelope
 */
async function gatewayRequest(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const requestBody = {
    team_id: TEAM_ID,
    agent_id: AGENT_ID,
    user_id: USER_ID,
    ...(TASK_ID ? { task_id: TASK_ID } : {}),
    ...payload,
  };

  const headers = {
    "Content-Type": "application/json",
    "x-tdai-service-id": SERVICE_ID,
  };
  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  try {
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { items: [], error: `gateway ${res.status}: ${text.slice(0, 200)}` };
    }

    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    const reason = err?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(err?.message ?? err);
    return { items: [], error: `gateway unreachable — ${reason}` };
  }
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

/**
 * Formats gateway memory items or raw results into readable plain text for OpenCode.
 * @param {Array<object>|string} items
 * @returns {string}
 */
function formatMemoryItems(items) {
  if (typeof items === "string") return items;
  if (!Array.isArray(items) || items.length === 0) return "(no memories found)";
  return items
    .map((item, i) => {
      const score = item.score != null ? ` [score: ${item.score.toFixed(3)}]` : "";
      const content = item.content ?? item.text ?? item.summary ?? item.memory ?? JSON.stringify(item);
      return `${i + 1}.${score}\n${content}`;
    })
    .join("\n\n");
}

/**
 * Handles tdai_memory_search via v3 atomic search endpoint (/v3/atomic/search).
 * @param {{ query: string; limit?: number }} args
 * @returns {Promise<{ content: Array<{ type: string; text: string }> }>}
 */
async function handleMemorySearch(args) {
  const limit = typeof args.limit === "number" ? args.limit : RECALL_LIMIT;
  const result = await gatewayRequest("/v3/atomic/search", {
    query: args.query,
    limit,
  });

  const text = result.error
    ? `[tdai_memory_search] Warning: ${result.error}\n(memory search failed gracefully)`
    : `[tdai_memory_search] Results for: "${args.query}"\n\n${formatMemoryItems(result.items ?? result.data ?? result.results ?? [])}`;

  return { content: [{ type: "text", text }] };
}

/**
 * Handles tdai_conversation_search via v3 conversation search endpoint (/v3/conversation/search).
 * @param {{ query: string; limit?: number }} args
 * @returns {Promise<{ content: Array<{ type: string; text: string }> }>}
 */
async function handleConversationSearch(args) {
  const limit = typeof args.limit === "number" ? args.limit : RECALL_LIMIT;
  const result = await gatewayRequest("/v3/conversation/search", {
    query: args.query,
    limit,
  });

  const text = result.error
    ? `[tdai_conversation_search] Warning: ${result.error}\n(conversation search failed gracefully)`
    : `[tdai_conversation_search] Results for: "${args.query}"\n\n${formatMemoryItems(result.items ?? result.data ?? result.results ?? [])}`;

  return { content: [{ type: "text", text }] };
}

// ── MCP stdio protocol ────────────────────────────────────────────────────────

/**
 * Sends a JSON-RPC response to stdout.
 * @param {number|string|null} id
 * @param {object} result
 */
function sendResult(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

/**
 * Sends a JSON-RPC error to stdout.
 * @param {number|string|null} id
 * @param {number} code
 * @param {string} message
 */
function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

/**
 * Handles a single MCP JSON-RPC request object.
 * @param {{ id: any; method: string; params?: any }} req
 */
async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tdai-memory-opencode", version: "1.0.0" },
      });
      break;

    case "tools/list":
      sendResult(id, { tools: TOOLS });
      break;

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};

      try {
        let toolResult;
        if (toolName === "tdai_memory_search") {
          toolResult = await handleMemorySearch(toolArgs);
        } else if (toolName === "tdai_conversation_search") {
          toolResult = await handleConversationSearch(toolArgs);
        } else {
          sendError(id, -32601, `Unknown tool: ${toolName}`);
          return;
        }
        sendResult(id, toolResult);
      } catch (err) {
        // Tool errors should never crash the server — send as tool error text
        sendResult(id, {
          content: [{ type: "text", text: `[error] ${String(err?.message ?? err)}` }],
          isError: true,
        });
      }
      break;
    }

    case "notifications/initialized":
      // No response needed for notifications
      break;

    default:
      if (id != null) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// ── Main: read newline-delimited JSON from stdin ──────────────────────────────

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? ""; // keep incomplete last line

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const req = JSON.parse(trimmed);
      handleRequest(req).catch((err) => {
        process.stderr.write(`[tdai-mcp] unhandled error: ${err}\n`);
      });
    } catch {
      process.stderr.write(`[tdai-mcp] failed to parse: ${trimmed}\n`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT",  () => process.exit(0));

process.stderr.write(`[tdai-mcp] OpenCode adapter started — gateway: ${GATEWAY_URL}, service: ${SERVICE_ID}, agent: ${AGENT_ID}\n`);
