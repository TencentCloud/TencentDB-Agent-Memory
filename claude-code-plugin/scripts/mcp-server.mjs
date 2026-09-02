#!/usr/bin/env node

import readline from "node:readline";
import {
  GatewayClient,
  boundedInteger,
  boundedText
} from "./gateway-client.mjs";

const SERVER_NAME = "tencentdb-agent-memory";
const SERVER_VERSION = "0.3.6";
const CURRENT_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  CURRENT_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]);
const MAX_LINE_CHARS = 2_000_000;
const MAX_TOOL_TEXT_CHARS = 250_000;

const tools = [
  {
    name: "tdai_memory_search",
    description:
      "Search durable L1 memories from earlier sessions. Use this when automatic recall is insufficient and a past fact, preference, or decision is relevant.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused semantic or keyword search query."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 5,
          description: "Maximum number of results."
        },
        type: {
          type: "string",
          description: "Optional memory type filter supported by the Gateway."
        },
        scene: {
          type: "string",
          description: "Optional scene filter supported by the Gateway."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "tdai_conversation_search",
    description:
      "Search captured L0 conversation history. Use this when exact wording or chronological context from earlier turns matters.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused semantic or keyword search query."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 5,
          description: "Maximum number of results."
        },
        session_key: {
          type: "string",
          description: "Optional exact Gateway session key filter."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "tdai_memory_health",
    description:
      "Check whether the TencentDB Agent Memory Gateway and its stores are available.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false
});

input.on("line", (line) => {
  void handleLine(line);
});

input.on("error", (error) => {
  logError("stdin", error);
});

process.on("uncaughtException", (error) => {
  logError("uncaught exception", error);
});

process.on("unhandledRejection", (error) => {
  logError("unhandled rejection", error);
});

async function handleLine(line) {
  if (line.length > MAX_LINE_CHARS) {
    writeError(null, -32600, "JSON-RPC request exceeded the adapter safety limit");
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }

  if (
    !request ||
    request.jsonrpc !== "2.0" ||
    typeof request.method !== "string" ||
    Array.isArray(request)
  ) {
    writeError(request?.id ?? null, -32600, "Invalid Request");
    return;
  }

  // Notifications do not receive responses.
  const isNotification = !Object.prototype.hasOwnProperty.call(request, "id");
  if (isNotification) return;

  try {
    const result = await dispatch(request.method, request.params ?? {});
    writeResult(request.id, result);
  } catch (error) {
    if (error instanceof RpcError) {
      writeError(request.id, error.code, error.message, error.data);
      return;
    }
    logError(request.method, error);
    writeError(request.id, -32603, "Internal error");
  }
}

async function dispatch(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion:
          typeof params?.protocolVersion === "string" &&
          SUPPORTED_PROTOCOL_VERSIONS.has(params.protocolVersion)
            ? params.protocolVersion
            : CURRENT_PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        },
        instructions:
          "Automatic recall and capture are handled by plugin hooks. Use the search tools only when deeper historical lookup is needed."
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call":
      return callTool(params);
    case "shutdown":
      return null;
    default:
      throw new RpcError(-32601, "Method not found");
  }
}

async function callTool(params) {
  const name = typeof params?.name === "string" ? params.name : "";
  const args =
    params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};

  try {
    const client = new GatewayClient();
    if (name === "tdai_memory_health") {
      const result = await client.health();
      return toolText(JSON.stringify(result, null, 2));
    }

    if (name === "tdai_memory_search") {
      const query = requireQuery(args.query);
      const result = await client.searchMemories({
        query,
        limit: boundedInteger(args.limit, 5, 1, 20),
        type: optionalToolString(args.type, 128),
        scene: optionalToolString(args.scene, 256)
      });
      return toolText(formatSearchResult(result));
    }

    if (name === "tdai_conversation_search") {
      const query = requireQuery(args.query);
      const result = await client.searchConversations({
        query,
        limit: boundedInteger(args.limit, 5, 1, 20),
        session_key: optionalToolString(args.session_key, 512)
      });
      return toolText(formatSearchResult(result));
    }

    throw new RpcError(-32602, `Unknown tool: ${name || "(missing)"}`);
  } catch (error) {
    if (error instanceof RpcError) throw error;
    const code = typeof error?.code === "string" ? ` [${error.code}]` : "";
    const message =
      typeof error?.message === "string" ? error.message.slice(0, 500) : "Unknown error";
    return {
      content: [
        {
          type: "text",
          text: `TencentDB Agent Memory request failed${code}: ${message}`
        }
      ],
      isError: true
    };
  }
}

function formatSearchResult(result) {
  if (typeof result?.results === "string" && result.results) {
    return boundedText(result.results, MAX_TOOL_TEXT_CHARS);
  }
  return JSON.stringify(result ?? {}, null, 2);
}

function toolText(value) {
  return {
    content: [
      {
        type: "text",
        text: boundedText(String(value), MAX_TOOL_TEXT_CHARS)
      }
    ]
  };
}

function requireQuery(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RpcError(-32602, "query must be a non-empty string");
  }
  return boundedText(value.trim(), 10_000);
}

function optionalToolString(value, maximumChars) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return boundedText(value.trim(), maximumChars);
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`);
}

function logError(scope, error) {
  const message =
    typeof error?.message === "string" ? error.message.slice(0, 500) : String(error).slice(0, 500);
  process.stderr.write(`[tencentdb-agent-memory] ${scope}: ${message}\n`);
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}
