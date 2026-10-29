import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface MemoryConfig {
  proxyUrl: string;
  userKey: string;
  spaceId: string;
  agentSource: string;
}

const fields = {
  "atomic/search": ["query", "limit", "type", "time_start", "time_end", "task_id", "agent_id"],
  "atomic/query": ["type", "limit", "offset", "time_start", "time_end", "task_id", "agent_id"],
  "conversation/search": ["query", "limit", "session_id", "task_id", "agent_id"],
  "conversation/query": ["session_id", "limit", "offset", "time_start", "time_end", "task_id", "agent_id"],
  "scenario/ls": ["path_prefix", "agent_id"],
  "scenario/read": ["path", "agent_id"],
};
type Endpoint = keyof typeof fields;
interface MemoryResponse { code: number; data: Record<string, unknown> }

/** Keep non-ASCII JSON out of Windows native command-line arguments entirely. */
export async function requestMemory(
  config: MemoryConfig,
  endpoint: Endpoint,
  body: Record<string, unknown>,
  sessionId: string,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<MemoryResponse> {
  if (!Object.hasOwn(fields, endpoint) || !body || Array.isArray(body)
    || Object.keys(body).some((key) => !fields[endpoint].includes(key))) {
    throw new Error("Unsupported read-only memory request.");
  }
  if (!sessionId || /[\s\x00-\x1f\x7f]/.test(sessionId)) throw new Error("Current Pi session is unavailable.");
  const url = new URL(config.proxyUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Memory proxy must be an HTTP(S) base URL without credentials, query or fragment.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/memory-bridge/v3/${endpoint}`;
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  if (payload.length > 64 * 1024) throw new Error("Memory request is too large.");

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    // Use Node's normal TLS trust, including NODE_EXTRA_CA_CERTS at startup.
    // Never follow redirects carrying the business key to a different origin.
    const req = request(url, {
      method: "POST", agent: false, signal,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": payload.length,
        "x-api-key": config.userKey,
        "x-tdai-service-id": config.spaceId,
        "x-tdai-agent-source": config.agentSource,
        "x-conversation-id": `pi-${sessionId}`,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) req.destroy(new Error("Memory response is too large."));
        else chunks.push(chunk);
      });
      res.on("error", () => { clearTimeout(timer); reject(new Error("Memory response could not be read.")); });
      res.on("end", () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) return reject(new Error(`Memory request failed: HTTP ${res.statusCode}.`));
        let result: MemoryResponse;
        try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { return reject(new Error("Memory response is not valid UTF-8 JSON.")); }
        if (!result || result.code !== 0 || !result.data || typeof result.data !== "object") {
          return reject(new Error(`Memory request failed: code ${Number.isInteger(result?.code) ? result.code : "invalid"}.`));
        }
        if (endpoint === "scenario/read") {
          if (result.data.path !== body.path) return reject(new Error("Scene response path does not match the requested path."));
          if (result.data.content === null) return reject(new Error("Scene content was not found; check the indexed path and source agent_id."));
          if (typeof result.data.content !== "string") return reject(new Error("Invalid scene content response."));
        }
        resolve(result);
      });
    });
    req.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // Do not return server bodies or network messages that can reflect secrets.
      const message = error.code === "ABORT_ERR" ? "Memory request cancelled."
        : error.message === "Memory request timed out." || error.message === "Memory response is too large."
          ? error.message : "Memory request failed; check connectivity and TLS trust.";
      reject(new Error(message));
    });
    timer = setTimeout(() => req.destroy(new Error("Memory request timed out.")), timeoutMs);
    req.end(payload);
  });
}

// Plain JSON Schema keeps the extension free of runtime schema dependencies.
const text = (description: string) => ({ type: "string" as const, minLength: 1, description });
const limit = { type: "integer" as const, minimum: 1, maximum: 100 };
const offset = { type: "integer" as const, minimum: 0 };
const agent = { agent_id: text("Source Agent ID from the injected index when reading imported memory; omit for the default scope.") };
const task = { task_id: text("Optional task scope; omit to use the server's current identity scope.") };
const times = { time_start: text("ISO 8601 start time"), time_end: text("ISO 8601 end time") };
const query = text("Short search phrase; Unicode is supported.");
const session = { session_id: text("Target historical session ID, not the current authenticating session. Omit for cross-session queries.") };
const tools: Array<{ name: string; endpoint: Endpoint; description: string; properties: Record<string, ReturnType<typeof text> | typeof limit | typeof offset> }> = [
  { name: "tdai_memory_search", endpoint: "atomic/search", description: "Search L1 atomic memory; matches are in data.items.", properties: { query, limit, type: text("episodic / persona / instruction"), ...times, ...task, ...agent } },
  { name: "tdai_atomic_query", endpoint: "atomic/query", description: "List L1 memory by type, time or pagination.", properties: { type: text("episodic / persona / instruction"), limit, offset, ...times, ...task, ...agent } },
  { name: "tdai_conversation_search", endpoint: "conversation/search", description: "Search L0 conversation history; matches are in data.messages.", properties: { query, limit, ...session, ...task, ...agent } },
  { name: "tdai_conversation_query", endpoint: "conversation/query", description: "Read L0 history by session, time or pagination.", properties: { ...session, limit, offset, ...times, ...task, ...agent } },
  { name: "tdai_scenario_ls", endpoint: "scenario/ls", description: "List L2 scene paths and summaries without reading their bodies.", properties: { path_prefix: text("Optional scene path prefix"), ...agent } },
  { name: "tdai_read_scene", endpoint: "scenario/read", description: "Read an L2 scene body. Copy path exactly from the injected index or tdai_scenario_ls, and include its source agent_id for imported memory.", properties: { path: text("Exact indexed scene path"), ...agent } },
];

export function registerMemoryTools(pi: ExtensionAPI, config: MemoryConfig) {
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name, label: tool.name,
      description: `${tool.description} Native read-only TDAI tool; use directly instead of shell/curl recipes.`,
      parameters: {
        type: "object" as const, properties: tool.properties, additionalProperties: false,
        required: tool.endpoint.endsWith("/search") ? ["query"] : tool.endpoint === "scenario/read" ? ["path"] : [],
      },
      async execute(_id, params, signal, _onUpdate, ctx) {
        if (process.env.PI_OFFLINE !== undefined) throw new Error("Memory reads are unavailable in offline mode.");
        if (ctx.model?.provider !== "tdai") throw new Error("Select the tdai provider to query this session's memory.");
        // The header identifies this live session; params.session_id may select older history.
        const result = await requestMemory(config, tool.endpoint, params, ctx.sessionManager.getSessionId(), signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result).split(config.userKey).join("<REDACTED>") }],
          details: {},
        };
      },
    });
  }
}
