#!/usr/bin/env node
/**
 * TencentDB Agent Memory — OpenCode MCP Adapter
 *
 * A minimal MCP stdio server that exposes TencentDB Agent Memory tools
 * to OpenCode via the Model Context Protocol (MCP).
 *
 * How it works:
 *   OpenCode <--stdio--> this server <--HTTP--> TencentDB Gateway
 *
 * Tools exposed:
 *   - tdai_memory_search        Search long-term memory (L1/L2/L3)
 *   - tdai_conversation_search  Search raw conversation history (L0)
 *
 * Related:
 *   - Issue #926: https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/926
 *   - OpenCode MCP docs: https://opencode.ai/docs/mcp-servers
 *   - MCP spec: https://modelcontextprotocol.io
 */

// ── Config ────────────────────────────────────────────────────────────────────

const GATEWAY_URL = (process.env.TDAI_GATEWAY_URL ?? "http://localhost:8420").replace(/\/$/, "");
const ADMIN_KEY   = process.env.TDAI_ADMIN_KEY ?? "";
const AGENT_ID    = process.env.TDAI_AGENT_ID  ?? "opencode";
const TEAM_ID     = process.env.TDAI_TEAM_ID   ?? "default";
const USER_ID     = process.env.TDAI_USER_ID   ?? "default";
const RECALL_LIMIT = parseInt(process.env.TDAI_RECALL_LIMIT ?? "5", 10);
const TIMEOUT_MS   = parseInt(process.env.TDAI_TIMEOUT_MS   ?? "5000", 10);

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "tdai_memory_search",
    description:
      "Search TencentDB Agent Memory for relevant past facts, user preferences, " +
      "project context, or distilled knowledge. Use this before starting any task " +
      "to recall what the agent already knows.",
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
      "Search raw conversation history stored in TencentDB Agent Memory. " +
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
 * Makes an HTTP request to the TencentDB gateway.
 * Fail-open: returns { items: [], error: <reason> } on any network / gateway error
 * so OpenCode never crashes due to a memory lookup failure.
 *
 * @param {string} path  - API path, e.g. "/v3/memory/recall"
 * @param {object} body  - JSON body to POST
 * @returns {Promise<object>} Parsed JSON response or error envelope
 */
async function gatewayRequest(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_KEY}`,
        "X-Agent-Id": AGENT_ID,
        "X-Team-Id": TEAM_ID,
        "X-User-Id": USER_ID,
      },
      body: JSON.stringify(body),
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
 * Formats gateway memory items into readable plain text for OpenCode.
 * @param {Array<object>} items
 * @returns {string}
 */
function formatMemoryItems(items) {
  if (!Array.isArray(items) || items.length === 0) return "(no memories found)";
  return items
    .map((item, i) => {
      const score = item.score != null ? ` [score: ${item.score.toFixed(3)}]` : "";
      const content = item.content ?? item.text ?? item.summary ?? JSON.stringify(item);
      return `${i + 1}.${score}\n${content}`;
    })
    .join("\n\n");
}

/**
 * @param {{ query: string; limit?: number }} args
 * @returns {Promise<{ content: Array<{ type: string; text: string }> }>}
 */
async function handleMemorySearch(args) {
  const limit = typeof args.limit === "number" ? args.limit : RECALL_LIMIT;
  const result = await gatewayRequest("/v3/memory/recall", {
    query: args.query,
    limit,
    agentId: AGENT_ID,
    teamId: TEAM_ID,
    userId: USER_ID,
  });

  const text = result.error
    ? `[tdai_memory_search] Warning: ${result.error}\n(memory search failed gracefully)`
    : `[tdai_memory_search] Results for: "${args.query}"\n\n${formatMemoryItems(result.items ?? result.data ?? [])}`;

  return { content: [{ type: "text", text }] };
}

/**
 * @param {{ query: string; limit?: number }} args
 * @returns {Promise<{ content: Array<{ type: string; text: string }> }>}
 */
async function handleConversationSearch(args) {
  const limit = typeof args.limit === "number" ? args.limit : RECALL_LIMIT;
  const result = await gatewayRequest("/v3/conversation/search", {
    query: args.query,
    limit,
    agentId: AGENT_ID,
    teamId: TEAM_ID,
    userId: USER_ID,
  });

  const text = result.error
    ? `[tdai_conversation_search] Warning: ${result.error}\n(conversation search failed gracefully)`
    : `[tdai_conversation_search] Results for: "${args.query}"\n\n${formatMemoryItems(result.items ?? result.data ?? [])}`;

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

process.stderr.write(`[tdai-mcp] OpenCode adapter started — gateway: ${GATEWAY_URL}, agent: ${AGENT_ID}\n`);
