import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
const DEFAULT_GATEWAY_TIMEOUT_MS = 10_000;
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

function optionNumber(options, key, envName, fallback) {
  const value = options?.[key] ?? process.env[envName];
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function optionFlag(options, key, envName, fallback = false) {
  const value = options?.[key] ?? process.env[envName];
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|on)$/i.test(String(value));
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
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Audit logging is best-effort and must not block OpenCode.
  }
}

async function gatewayRequest(fetchImpl, gatewayUrl, apiKey, timeoutMs, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const res = await fetchImpl(`${trimSlash(gatewayUrl)}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (!res.ok) throw new Error(`Gateway ${path} failed with HTTP ${res.status}: ${text.slice(0, 500)}`);
        throw new Error(`Gateway ${path} returned invalid JSON`);
      }
    }
    if (!res.ok) {
      const detail = typeof data?.error === "string" ? data.error : "";
      throw new Error(`Gateway ${path} failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Gateway ${path} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function appendContextBlock(context, block) {
  const current = String(context || "").trim();
  const addition = String(block || "").trim();
  if (!addition || current.includes(addition)) return current;
  return current ? `${current}\n\n${addition}` : addition;
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function createMemoryTencentDBPlugin(context, options = {}) {
  const gatewayUrl = optionString(options, "gatewayUrl", "MEMORY_TENCENTDB_GATEWAY_URL", DEFAULT_GATEWAY_URL);
  const apiKey = optionString(options, "apiKey", "MEMORY_TENCENTDB_GATEWAY_API_KEY", "");
  const userId = optionString(options, "userId", "MEMORY_TENCENTDB_USER_ID", "");
  const auditLog = optionString(options, "auditLog", "MEMORY_TENCENTDB_OPENCODE_AUDIT_LOG", "");
  const timeoutMs = optionNumber(
    options,
    "timeoutMs",
    "MEMORY_TENCENTDB_GATEWAY_TIMEOUT_MS",
    DEFAULT_GATEWAY_TIMEOUT_MS,
  );
  const disableL0Recall = optionFlag(
    options,
    "disableL0Recall",
    "MEMORY_TENCENTDB_DISABLE_L0_RECALL",
  );
  const globalL0Fallback = optionFlag(
    options,
    "globalL0Fallback",
    "MEMORY_TENCENTDB_GLOBAL_L0_FALLBACK",
  );
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const state = {
    prompts: new Map(),
    messageInfo: new Map(),
    textPartsByMessage: new Map(),
    settledSessions: new Set(),
  };

  async function post(path, body) {
    return gatewayRequest(fetchImpl, gatewayUrl, apiKey, timeoutMs, path, body);
  }

  function sessionKeyFor(input) {
    return buildSessionKey(input, context, options);
  }

  function clearMessageState(sessionID) {
    for (const [messageID, info] of state.messageInfo) {
      if (info.sessionID === sessionID) {
        state.messageInfo.delete(messageID);
        state.textPartsByMessage.delete(messageID);
      }
    }
  }

  function clearSession(sessionID) {
    state.prompts.delete(sessionID);
    clearMessageState(sessionID);
    state.settledSessions.add(sessionID);
  }

  function rememberPart(part, delta) {
    if (!part?.messageID || !part?.sessionID || part.type !== "text") return;
    const existingInfo = state.messageInfo.get(part.messageID);
    state.messageInfo.set(part.messageID, {
      role: existingInfo?.role,
      sessionID: part.sessionID,
    });
    let parts = state.textPartsByMessage.get(part.messageID);
    if (!parts) {
      parts = new Map();
      state.textPartsByMessage.set(part.messageID, parts);
    }
    const partID = part.id || `${part.messageID}:text`;
    const fullText = textFromContent(part.text);
    if (Object.prototype.hasOwnProperty.call(part, "text")) {
      // OpenCode sends the complete part on each update. Replace by part id instead of
      // appending the growing prefix repeatedly.
      if (fullText) parts.set(partID, fullText);
      else parts.delete(partID);
      return;
    }
    if (typeof delta === "string" && delta) {
      parts.set(partID, `${parts.get(partID) || ""}${delta}`);
    }
  }

  function assistantTextFor(sessionID, preferredMessageID) {
    const messageIDs = [];
    if (preferredMessageID) messageIDs.push(preferredMessageID);
    for (const [messageID, info] of state.messageInfo) {
      if (info.role === "assistant" && info.sessionID === sessionID && messageID !== preferredMessageID) {
        messageIDs.push(messageID);
      }
    }
    return messageIDs
      .flatMap((messageID) => [...(state.textPartsByMessage.get(messageID)?.values() || [])])
      .map((text) => String(text).trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  async function searchConversationFallback(prompt, sessionKey) {
    const scoped = await post("/search/conversations", {
      query: prompt,
      limit: 3,
      session_key: sessionKey,
    });
    if (Number(scoped?.total || 0) > 0 || !globalL0Fallback) {
      return { result: scoped, scope: "session" };
    }
    return {
      result: await post("/search/conversations", { query: prompt, limit: 3 }),
      scope: "global",
    };
  }

  async function recallContext(prompt, sessionKey) {
    const recallRequest = post("/recall", {
      query: prompt,
      session_key: sessionKey,
      user_id: userId || undefined,
    });
    const l0Request = disableL0Recall
      ? undefined
      : searchConversationFallback(prompt, sessionKey);
    const [recall, l0] = await Promise.allSettled([
      recallRequest,
      l0Request ?? Promise.resolve(undefined),
    ]);
    let memoryContext = recall.status === "fulfilled" && typeof recall.value?.context === "string"
      ? recall.value.context
      : "";
    let l0Scope;
    if (l0.status === "fulfilled" && l0.value) {
      const results = typeof l0.value.result?.results === "string" ? l0.value.result.results.trim() : "";
      if (Number(l0.value.result?.total || 0) > 0 && results) {
        l0Scope = l0.value.scope;
        memoryContext = appendContextBlock(
          memoryContext,
          `Relevant prior conversation memory from memory-tencentdb (${l0Scope}-scoped):\n\n${results}`,
        );
      }
    }
    if (recall.status === "rejected" && (l0.status === "rejected" || !memoryContext)) {
      throw recall.reason;
    }
    return {
      context: memoryContext,
      l0Scope,
      recallError: recall.status === "rejected" ? recall.reason : undefined,
      l0Error: l0.status === "rejected" ? l0.reason : undefined,
    };
  }

  async function captureOrFlush(sessionID, preferredMessageID, flushIfIncomplete = true) {
    if (state.settledSessions.has(sessionID)) return;
    const prompt = state.prompts.get(sessionID);
    const assistantText = assistantTextFor(sessionID, preferredMessageID);
    const sessionKey = prompt?.sessionKey || buildSessionKey({ sessionID }, context, options);
    if (prompt?.text && assistantText) {
      const capturedAt = Date.now();
      await post("/capture", {
        user_content: prompt.text,
        assistant_content: assistantText,
        session_key: sessionKey,
        session_id: sessionID,
        user_id: userId || undefined,
        messages: [
          { role: "user", content: prompt.text, timestamp: capturedAt },
          { role: "assistant", content: assistantText, timestamp: capturedAt },
        ],
        started_at: capturedAt - 1,
      });
      await writeAudit(auditLog, {
        platform: PLATFORM,
        outcome: "capture",
        session_key_hash: shortHash(sessionKey),
        session_id_hash: shortHash(sessionID),
      });
      clearSession(sessionID);
      return;
    }

    if (!flushIfIncomplete) return;

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
    clearSession(sessionID);
  }

  async function flushErroredSession(sessionID) {
    if (state.settledSessions.has(sessionID)) return;
    const prompt = state.prompts.get(sessionID);
    const sessionKey = prompt?.sessionKey || buildSessionKey({ sessionID }, context, options);
    await post("/session/end", {
      session_key: sessionKey,
      user_id: userId || undefined,
    });
    await writeAudit(auditLog, {
      platform: PLATFORM,
      outcome: "session_error_flush",
      session_key_hash: shortHash(sessionKey),
      session_id_hash: shortHash(sessionID),
    });
    clearSession(sessionID);
  }

  async function safelyRunLifecycle(sessionID, operation, run) {
    try {
      await run();
    } catch (error) {
      await writeAudit(auditLog, {
        platform: PLATFORM,
        outcome: `${operation}_error`,
        error: errorMessage(error),
        session_id_hash: shortHash(sessionID),
      });
    }
  }

  return {
    "chat.message": async (input, output) => {
      const prompt = extractTextFromParts(output.parts);
      if (!prompt) return;
      const sessionKey = sessionKeyFor(input);
      state.settledSessions.delete(input.sessionID);
      clearMessageState(input.sessionID);
      state.prompts.set(input.sessionID, {
        text: prompt,
        sessionKey,
      });

      try {
        const recall = await recallContext(prompt, sessionKey);
        const injected = appendRecallContext(output, input, recall.context);
        await writeAudit(auditLog, {
          platform: PLATFORM,
          outcome: "recall",
          injected,
          context_chars: typeof recall.context === "string" ? recall.context.length : 0,
          l0_scope: recall.l0Scope,
          recall_error: recall.recallError ? errorMessage(recall.recallError) : undefined,
          l0_error: recall.l0Error ? errorMessage(recall.l0Error) : undefined,
          session_key_hash: shortHash(sessionKey),
          session_id_hash: shortHash(input.sessionID),
        });
      } catch (error) {
        await writeAudit(auditLog, {
          platform: PLATFORM,
          outcome: "recall_error",
          error: errorMessage(error),
          session_key_hash: shortHash(sessionKey),
          session_id_hash: shortHash(input.sessionID),
        });
      }
    },

    event: async ({ event }) => {
      const type = event?.type;
      if (type === "message.part.updated") {
        rememberPart(event.properties?.part, event.properties?.delta);
        return;
      }

      if (type === "message.updated") {
        const info = event.properties?.info;
        if (info?.id && info?.role) {
          const existingInfo = state.messageInfo.get(info.id);
          state.messageInfo.set(info.id, {
            role: info.role,
            sessionID: info.sessionID || existingInfo?.sessionID,
          });
        }
        if (info?.role === "assistant" && info?.sessionID && info?.time?.completed) {
          await safelyRunLifecycle(
            info.sessionID,
            "capture",
            () => captureOrFlush(info.sessionID, info.id, false),
          );
        }
        return;
      }

      if (type === "session.idle") {
        const sessionID = event.properties?.sessionID || event.properties?.id;
        if (sessionID) {
          await safelyRunLifecycle(sessionID, "capture", () => captureOrFlush(sessionID));
        }
        return;
      }

      if (type === "session.error") {
        const sessionID = event.properties?.sessionID || event.properties?.id;
        if (sessionID) {
          await safelyRunLifecycle(sessionID, "session_error_flush", () => flushErroredSession(sessionID));
        }
      }
    },
  };
}

export const MemoryTencentDBOpenCodePlugin = createMemoryTencentDBPlugin;
export const server = createMemoryTencentDBPlugin;
export default createMemoryTencentDBPlugin;
