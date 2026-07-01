import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
const PLATFORM = "opencode";
const OPENCODE_PART_RANDOM_LENGTH = 14;
let lastPartTimestamp = 0;
let partCounter = 0;

function trimSlash(value) {
  return String(value || DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
}

function optionString(options, key, envName, fallback = "") {
  const value = options?.[key] ?? process.env[envName];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function shortHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function randomBase62(length) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(length);
  return [...bytes].map((byte) => chars[byte % chars.length]).join("");
}

function openCodePartId() {
  const timestamp = Date.now();
  if (timestamp !== lastPartTimestamp) {
    lastPartTimestamp = timestamp;
    partCounter = 0;
  }
  partCounter += 1;
  const encodedTime = (BigInt(timestamp) * BigInt(0x1000) + BigInt(partCounter))
    .toString(16)
    .padStart(12, "0")
    .slice(-12);
  return `prt_${encodedTime}${randomBase62(OPENCODE_PART_RANDOM_LENGTH)}`;
}

function textFromContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return textFromContent(value.text ?? value.content ?? value.message ?? value.input);
  }
  return "";
}

export function extractTextFromParts(parts = []) {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return textFromContent(part.text);
      if ("content" in part) return textFromContent(part.content);
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function buildSessionKey(input, context = {}, options = {}) {
  const explicit = optionString(options, "sessionKey", "MEMORY_TENCENTDB_SESSION_KEY");
  if (explicit) return explicit;
  const sessionID =
    input?.sessionID ||
    input?.session_id ||
    input?.properties?.sessionID ||
    input?.properties?.session_id ||
    "default";
  const root = context.worktree || context.directory || process.cwd();
  const name = String(root || "workspace").split(/[\\/]/).filter(Boolean).pop() || "workspace";
  return `${PLATFORM}:cwd:${name}:${shortHash(root)}:${sessionID}`;
}

function textPart(text, input, output) {
  const first = Array.isArray(output?.parts) ? output.parts[0] : undefined;
  return {
    id: openCodePartId(),
    sessionID: input?.sessionID || output?.message?.sessionID || first?.sessionID || "",
    messageID: input?.messageID || output?.message?.id || first?.messageID || "",
    type: "text",
    text,
    synthetic: true,
  };
}

async function writeAudit(file, entry) {
  if (!file) return;
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf-8");
  } catch {
    // Audit logging is best-effort and must not block OpenCode.
  }
}

async function gatewayRequest(fetchImpl, gatewayUrl, apiKey, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(`${trimSlash(gatewayUrl)}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(data.error || `Gateway ${path} failed: ${res.status}`);
  }
  return data;
}

function appendRecallContext(output, input, context) {
  const text = String(context || "").trim();
  if (!text) return false;
  const block = [
    "<relevant-memories source=\"memory-tencentdb\">",
    text,
    "</relevant-memories>",
  ].join("\n");
  output.parts.unshift(textPart(block, input, output));
  return true;
}

export async function createMemoryTencentDBPlugin(context, options = {}) {
  const gatewayUrl = optionString(options, "gatewayUrl", "MEMORY_TENCENTDB_GATEWAY_URL", DEFAULT_GATEWAY_URL);
  const apiKey = optionString(options, "apiKey", "MEMORY_TENCENTDB_GATEWAY_API_KEY", "");
  const userId = optionString(options, "userId", "MEMORY_TENCENTDB_USER_ID", "");
  const auditLog = optionString(options, "auditLog", "MEMORY_TENCENTDB_OPENCODE_AUDIT_LOG", "");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const state = {
    prompts: new Map(),
    messageRoles: new Map(),
    assistantTextBySession: new Map(),
  };

  async function post(path, body) {
    return gatewayRequest(fetchImpl, gatewayUrl, apiKey, path, body);
  }

  function sessionKeyFor(input) {
    return buildSessionKey(input, context, options);
  }

  async function captureOrFlush(sessionID) {
    const prompt = state.prompts.get(sessionID);
    const assistantText = state.assistantTextBySession.get(sessionID);
    const sessionKey = prompt?.sessionKey || buildSessionKey({ sessionID }, context, options);
    if (prompt?.text && assistantText) {
      await post("/capture", {
        user_content: prompt.text,
        assistant_content: assistantText,
        session_key: sessionKey,
        session_id: sessionID,
        user_id: userId || undefined,
        messages: [
          { role: "user", content: prompt.text, timestamp: prompt.createdAt },
          { role: "assistant", content: assistantText, timestamp: Date.now() },
        ],
        started_at: prompt.createdAt,
      });
      await writeAudit(auditLog, {
        platform: PLATFORM,
        outcome: "capture",
        session_key_hash: shortHash(sessionKey),
        session_id_hash: shortHash(sessionID),
      });
      state.prompts.delete(sessionID);
      state.assistantTextBySession.delete(sessionID);
      return;
    }

    await post("/session/end", {
      session_key: sessionKey,
      user_id: userId || undefined,
    });
    await writeAudit(auditLog, {
      platform: PLATFORM,
      outcome: "session_end",
      session_key_hash: shortHash(sessionKey),
      session_id_hash: shortHash(sessionID),
    });
  }

  return {
    "chat.message": async (input, output) => {
      const prompt = extractTextFromParts(output.parts);
      if (!prompt) return;
      const sessionKey = sessionKeyFor(input);
      state.prompts.set(input.sessionID, {
        text: prompt,
        sessionKey,
        createdAt: Date.now(),
      });

      try {
        const recall = await post("/recall", {
          query: prompt,
          session_key: sessionKey,
          user_id: userId || undefined,
          include_l0: true,
          global_l0_fallback: false,
        });
        const injected = appendRecallContext(output, input, recall.context);
        await writeAudit(auditLog, {
          platform: PLATFORM,
          outcome: "recall",
          injected,
          context_chars: typeof recall.context === "string" ? recall.context.length : 0,
          session_key_hash: shortHash(sessionKey),
          session_id_hash: shortHash(input.sessionID),
        });
      } catch (err) {
        await writeAudit(auditLog, {
          platform: PLATFORM,
          outcome: "recall_error",
          error: err instanceof Error ? err.message : String(err),
          session_key_hash: shortHash(sessionKey),
          session_id_hash: shortHash(input.sessionID),
        });
      }
    },

    event: async ({ event }) => {
      const type = event?.type;
      if (type === "message.updated") {
        const info = event.properties?.info;
        if (info?.id && info?.role) state.messageRoles.set(info.id, info.role);
        if (info?.role === "assistant" && info?.sessionID && info?.time?.completed) {
          await captureOrFlush(info.sessionID);
        }
        return;
      }

      if (type === "message.part.updated") {
        const part = event.properties?.part;
        if (!part || part.type !== "text") return;
        if (state.messageRoles.get(part.messageID) !== "assistant") return;
        const existing = state.assistantTextBySession.get(part.sessionID) || "";
        const next = textFromContent(part.text).trim();
        if (next) state.assistantTextBySession.set(part.sessionID, [existing, next].filter(Boolean).join("\n"));
        return;
      }

      if (type === "session.idle" || type === "session.error") {
        const sessionID = event.properties?.sessionID || event.properties?.id;
        if (sessionID) await captureOrFlush(sessionID);
      }
    },
  };
}

export const MemoryTencentDBOpenCodePlugin = createMemoryTencentDBPlugin;
export const server = createMemoryTencentDBPlugin;
export default createMemoryTencentDBPlugin;
