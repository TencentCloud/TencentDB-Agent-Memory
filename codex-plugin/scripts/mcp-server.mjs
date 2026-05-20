#!/usr/bin/env node
import {
  cwdFromPayload,
  ensureGateway,
  httpPost,
  sessionKeyPrefixesForCwd
} from "./lib.mjs";
import {
  formatLookupText,
  lookupCodexOffload
} from "./offload-store.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const allProjectsEnabled = process.env.TDAI_CODEX_MCP_ALLOW_ALL_PROJECTS === "true";
const offloadContentEnabled = process.env.TDAI_CODEX_MCP_ALLOW_OFFLOAD_CONTENT === "true";

const tools = [
  {
    name: "tdai_memory_search",
    description: "Search TencentDB Agent Memory L1 structured memories for user preferences, prior decisions, durable facts, instructions, or scene summaries. Use before asking the user to repeat context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Include current project/path when relevant." },
        limit: { type: "number", description: "Maximum number of results, 1-20.", default: 5 },
        type: { type: "string", enum: ["persona", "episodic", "instruction"], description: "Optional memory type filter." },
        scene: { type: "string", description: "Optional scene name filter." },
        ...(allProjectsEnabled ? {
          all_projects: { type: "boolean", description: "Search across all projects instead of the current Codex project.", default: false }
        } : {})
      },
      required: ["query"]
    }
  },
  {
    name: "tdai_conversation_search",
    description: "Search TencentDB Agent Memory L0 raw conversation history for exact prior wording, timelines, paths, commands, or evidence snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Use exact phrases, paths, or markers when available." },
        limit: { type: "number", description: "Maximum number of messages, 1-20.", default: 5 },
        session_key: { type: "string", description: "Optional session key filter." },
        ...(allProjectsEnabled ? {
          all_projects: { type: "boolean", description: "Search across all projects instead of the current Codex project.", default: false }
        } : {})
      },
      required: ["query"]
    }
  },
  {
    name: "tdai_offload_lookup",
    description: "Look up Codex short-term context offload entries by node_id, tool_call_id, or query. Use this to retrieve the exact redacted tool result behind an injected Mermaid canvas node.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Mermaid node id from the injected context offload canvas." },
        tool_call_id: { type: "string", description: "Original Codex tool call id." },
        query: { type: "string", description: "Optional text query over tool names, summaries, refs, and cwd." },
        limit: { type: "number", description: "Maximum number of entries, 1-20.", default: 5 },
        ...(offloadContentEnabled ? {
          include_content: { type: "boolean", description: "Include stored redacted tool output content.", default: false }
        } : {}),
        ...(allProjectsEnabled ? {
          all_projects: { type: "boolean", description: "Search across all projects instead of the current Codex project.", default: false }
        } : {})
      }
    }
  }
];

let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    handleLine(line).catch((err) => {
      writeError(null, -32603, err instanceof Error ? err.message : String(err));
    });
  }
});

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }

  if (message.id === undefined) return;

  try {
    switch (message.method) {
      case "initialize":
        writeResult(message.id, {
          protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "tdai-memory-codex", version: "0.1.0" }
        });
        break;
      case "ping":
        writeResult(message.id, {});
        break;
      case "tools/list":
        writeResult(message.id, { tools });
        break;
      case "tools/call":
        writeResult(message.id, await callTool(message.params || {}));
        break;
      default:
        writeError(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (err) {
    writeError(message.id, -32603, err instanceof Error ? err.message : String(err));
  }
}

async function callTool(params) {
  const name = params.name;
  const args = params.arguments || {};

  if (name === "tdai_offload_lookup") {
    const allProjects = allProjectsEnabled && args.all_projects === true;
    const includeContent = offloadContentEnabled && args.include_content === true;
    if (args.all_projects === true && !allProjectsEnabled) {
      return textResult("Cross-project memory/offload lookup is disabled for MCP. Set TDAI_CODEX_MCP_ALLOW_ALL_PROJECTS=true outside the model context to enable it.", true);
    }
    if (args.include_content === true && !offloadContentEnabled) {
      return textResult("Exact offload content lookup is disabled for MCP. Set TDAI_CODEX_MCP_ALLOW_OFFLOAD_CONTENT=true outside the model context to enable it.", true);
    }
    const result = await lookupCodexOffload({
      nodeId: optionalString(args.node_id),
      toolCallId: optionalString(args.tool_call_id),
      query: optionalString(args.query),
      cwd: allProjects ? "" : currentProjectCwd(),
      includeContent,
      limit: clampLimit(args.limit)
    });
    return textResult(formatLookupText(result));
  }

  const ready = await ensureGateway();
  if (!ready) return textResult("TencentDB Agent Memory Gateway is unavailable.", true);

  if (name === "tdai_memory_search") {
    const allProjects = allProjectsEnabled && args.all_projects === true;
    if (args.all_projects === true && !allProjectsEnabled) {
      return textResult("Cross-project memory search is disabled for MCP. Set TDAI_CODEX_MCP_ALLOW_ALL_PROJECTS=true outside the model context to enable it.", true);
    }
    const query = scopedQuery(args.query, allProjects);
    const result = await httpPost("/search/memories", {
      query,
      limit: clampLimit(args.limit),
      type: optionalString(args.type),
      scene: optionalString(args.scene),
      session_key_prefixes: allProjects ? undefined : currentProjectPrefixes()
    });
    return textResult(result?.results || "No matching memories found.");
  }

  if (name === "tdai_conversation_search") {
    const allProjects = allProjectsEnabled && args.all_projects === true;
    if (args.all_projects === true && !allProjectsEnabled) {
      return textResult("Cross-project conversation search is disabled for MCP. Set TDAI_CODEX_MCP_ALLOW_ALL_PROJECTS=true outside the model context to enable it.", true);
    }
    const query = scopedQuery(args.query, allProjects);
    const body = {
      query,
      limit: clampLimit(args.limit),
      session_key_prefixes: allProjects ? undefined : currentProjectPrefixes()
    };
    const sessionKey = optionalString(args.session_key);
    if (sessionKey) body.session_key = sessionKey;
    const result = await httpPost("/search/conversations", body);
    return textResult(result?.results || "No matching conversations found.");
  }

  return textResult(`Unknown tool: ${name}`, true);
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampLimit(value) {
  const parsed = Number(value || 5);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

function currentProjectCwd() {
  return cwdFromPayload({
    cwd: process.env.CLAUDE_PROJECT_DIR || process.env.CODEX_PROJECT_DIR || process.cwd()
  });
}

function scopedQuery(query, allProjects) {
  const text = String(query || "");
  if (allProjects) return text;
  return `Codex project cwd: ${currentProjectCwd()}\n${text}`;
}

function currentProjectPrefixes() {
  return sessionKeyPrefixesForCwd(currentProjectCwd());
}

function textResult(text, isError = false) {
  return {
    content: [{ type: "text", text: String(text || "") }],
    isError
  };
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
