#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gatewayPost } from "./gateway-client.js";

const platform = process.env.MEMORY_TENCENTDB_HOOK_PLATFORM || "generic";
const eventName = process.env.MEMORY_TENCENTDB_HOOK_EVENT || "";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 25;

function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        return contentToText(part.text ?? part.content ?? part.message);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    return contentToText(content.text ?? content.content ?? content.message);
  }
  return "";
}

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(value);
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const asDate = new Date(value).getTime();
    if (Number.isFinite(asDate)) return asDate;
  }
  return undefined;
}

function timestampFrom(candidate, fallbackTimestamp) {
  if (!candidate || typeof candidate !== "object") return fallbackTimestamp;
  return parseTimestamp(
    candidate.timestamp ??
    candidate.created_at ??
    candidate.createdAt ??
    candidate.updated_at ??
    candidate.updatedAt ??
    candidate.message?.timestamp ??
    candidate.message?.created_at ??
    candidate.message?.createdAt,
  ) ?? fallbackTimestamp;
}

function normalizeMessage(candidate, fallbackTimestamp) {
  if (!candidate || typeof candidate !== "object") return undefined;
  const role =
    candidate.role ||
    candidate.type ||
    candidate.message?.role ||
    candidate.message?.type;
  if (role !== "user" && role !== "assistant") return undefined;

  const rawContent =
    candidate.content ??
    candidate.text ??
    candidate.message?.content ??
    candidate.message?.text ??
    candidate.message;
  const content = contentToText(rawContent).trim();
  if (!content) return undefined;
  const timestamp = timestampFrom(candidate, fallbackTimestamp);
  return timestamp != null ? { role, content, timestamp } : { role, content };
}

function normalizeMessages(messages, fallbackStart = Date.now()) {
  if (!Array.isArray(messages)) return [];
  const normalized = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = normalizeMessage(messages[i], fallbackStart + i);
    if (msg) normalized.push(msg);
  }
  return normalized;
}

function buildTurnMessages(userText, assistantText, start = Date.now()) {
  return [
    { role: "user", content: userText, timestamp: start },
    { role: "assistant", content: assistantText, timestamp: start + 1 },
  ];
}

function captureStartedAt(messages, explicitStartedAt) {
  const explicit = parseTimestamp(explicitStartedAt);
  if (explicit != null) return explicit;
  const timestamps = messages
    .map((msg) => parseTimestamp(msg?.timestamp))
    .filter((value) => value != null);
  if (timestamps.length === 0) return undefined;
  return Math.max(0, Math.min(...timestamps) - 1);
}

async function readTranscriptMessages(transcriptPath) {
  if (!transcriptPath) return [];
  try {
    const text = await readFile(transcriptPath.replace(/^~(?=\/)/, process.env.HOME || "~"), "utf-8");
    const messages = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const lineTimestamp = timestampFrom(entry, Date.now() + messages.length);
      const direct = normalizeMessage(entry, lineTimestamp);
      if (direct) {
        messages.push(direct);
        continue;
      }
      const nested = normalizeMessage(entry.message, lineTimestamp);
      if (nested) messages.push(nested);
    }
    return messages;
  } catch {
    return [];
  }
}

function latestByRole(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === role && messages[i]?.content) return messages[i].content;
  }
  return undefined;
}

function getCachePath() {
  const dir = process.env.MEMORY_TENCENTDB_HOOK_CACHE_DIR || join(tmpdir(), "memory-tencentdb-hooks");
  return join(dir, "last-prompts.json");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireCacheLock() {
  const file = getCachePath();
  const lockFile = `${file}.lock`;
  await mkdir(dirname(lockFile), { recursive: true });
  const started = Date.now();

  while (true) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf-8");
      return async () => {
        await handle.close().catch(() => {});
        await rm(lockFile, { force: true }).catch(() => {});
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const info = await stat(lockFile);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockFile, { force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr?.code !== "ENOENT") throw statErr;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error(`Timed out waiting for hook prompt cache lock: ${lockFile}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function withCacheLock(fn) {
  const release = await acquireCacheLock();
  try {
    return await fn();
  } finally {
    await release();
  }
}

function cacheKey({ sessionKey, sessionId, turnId }) {
  return [platform, sessionKey || "", sessionId || "", turnId || ""].join("\u001f");
}

async function loadCache() {
  try {
    return JSON.parse(await readFile(getCachePath(), "utf-8"));
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  const file = getCachePath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cache), "utf-8");
  await rename(tmp, file);
}

async function rememberPrompt(event) {
  if (!event.prompt) return;
  await withCacheLock(async () => {
    const now = Date.now();
    const cache = await loadCache();
    for (const [key, value] of Object.entries(cache)) {
      if (!value || typeof value !== "object" || now - Number(value.updatedAt || 0) > CACHE_MAX_AGE_MS) {
        delete cache[key];
      }
    }
    cache[cacheKey(event)] = {
      prompt: event.prompt,
      sessionKey: event.sessionKey,
      sessionId: event.sessionId,
      turnId: event.turnId,
      messages: event.messages,
      startedAt: event.startedAt,
      updatedAt: now,
    };
    await saveCache(cache);
  });
}

async function recallPrompt(event) {
  const cache = await loadCache();
  const exact = cache[cacheKey(event)];
  if (exact?.prompt) return exact;

  const candidates = Object.values(cache)
    .filter((entry) => entry?.sessionKey === event.sessionKey)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return candidates[0];
}

function writeAdditionalContext(eventNameForOutput, context) {
  if (!context) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventNameForOutput || eventName || "UserPromptSubmit",
      additionalContext: context,
    },
  }));
}

function cwdSessionKey(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return undefined;
  const normalized = cwd.trim();
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  const name = basename(normalized) || "workspace";
  return `${platform}:cwd:${name}:${digest}`;
}

function shortHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

async function writeAudit(event, outcome, extra = {}) {
  const file = process.env.MEMORY_TENCENTDB_HOOK_AUDIT_LOG;
  if (!file) return;
  const entry = {
    ts: new Date().toISOString(),
    platform,
    hook_event: eventName || undefined,
    type: event?.type,
    outcome,
    session_key_hash: shortHash(event?.sessionKey),
    session_id_hash: event?.sessionId ? shortHash(event.sessionId) : undefined,
    turn_id_hash: event?.turnId ? shortHash(event.turnId) : undefined,
    ...extra,
  };
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Audit logging must never block the host agent.
  }
}

function normalizeHookPayload(payload) {
  const lowerEvent = String(
    eventName ||
    payload?.hook_event_name ||
    payload?.event ||
    payload?.eventName ||
    payload?.type ||
    "",
  ).toLowerCase();

  const explicitSessionKey =
    process.env.MEMORY_TENCENTDB_SESSION_KEY ||
    firstString(payload, [
      "session_key",
      "sessionKey",
      "session_id",
      "sessionId",
      "thread_id",
      "threadId",
      "conversation_id",
      "conversationId",
    ]);

  const sessionKey =
    explicitSessionKey ||
    cwdSessionKey(payload?.cwd) ||
    `${platform}:default`;

  const sessionId = firstString(payload, [
    "session_id",
    "sessionId",
    "thread_id",
    "threadId",
    "conversation_id",
    "conversationId",
    "turn_id",
    "turnId",
  ]);
  const turnId = firstString(payload, ["turn_id", "turnId", "tool_use_id", "toolUseId"]);
  const startedAt = parseTimestamp(
    payload?.started_at ??
    payload?.startedAt ??
    payload?.created_at ??
    payload?.createdAt ??
    payload?.timestamp,
  );
  const transcriptPath = firstString(payload, [
    "transcript_path",
    "transcriptPath",
    "agent_transcript_path",
    "agentTranscriptPath",
  ]);

  const prompt = firstString(payload, [
    "prompt",
    "user_prompt",
    "userPrompt",
    "input",
    "message",
  ]);
  const userText = prompt || firstString(payload, ["user_content", "userContent", "userText"]);
  const assistantText = firstString(payload, [
    "assistant_content",
    "assistantContent",
    "assistantText",
    "last_assistant_message",
    "lastAssistantMessage",
    "response",
    "output",
    "final_response",
  ]);
  const messages = Array.isArray(payload?.messages) ? payload.messages : undefined;

  if (lowerEvent.includes("userpromptsubmit") || lowerEvent.includes("prompt")) {
    return { type: "before_prompt", prompt, sessionKey, sessionId, turnId, startedAt, transcriptPath, messages };
  }

  if (lowerEvent.includes("stop") || lowerEvent.includes("session_end")) {
    if (userText && assistantText) {
      return { type: "turn_committed", userText, assistantText, sessionKey, sessionId, turnId, startedAt, transcriptPath, messages };
    }
    return { type: "session_end", sessionKey, sessionId, turnId, startedAt, transcriptPath, assistantText, messages };
  }

  if (userText && assistantText) {
    return { type: "turn_committed", userText, assistantText, sessionKey, sessionId, turnId, startedAt, transcriptPath, messages };
  }
  if (prompt) {
    return { type: "before_prompt", prompt, sessionKey, sessionId, turnId, startedAt, transcriptPath, messages };
  }
  return { type: "session_end", sessionKey, sessionId, turnId, startedAt, transcriptPath, messages };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const input = await readStdin();
  const payload = input.trim() ? JSON.parse(input) : {};
  const event = normalizeHookPayload(payload);
  const userId = process.env.MEMORY_TENCENTDB_USER_ID || undefined;

  if (event.type === "before_prompt" && event.prompt) {
    await rememberPrompt(event);
    const result = await gatewayPost("/recall", {
      query: event.prompt,
      session_key: event.sessionKey,
      user_id: userId,
      include_l0: !envFlag("MEMORY_TENCENTDB_DISABLE_L0_RECALL"),
      global_l0_fallback: envFlag("MEMORY_TENCENTDB_GLOBAL_L0_FALLBACK"),
    });
    await writeAudit(event, "recall", {
      context_chars: typeof result.context === "string" ? result.context.length : 0,
    });
    writeAdditionalContext("UserPromptSubmit", result.context);
    return;
  }

  if (event.type === "turn_committed" && event.userText && event.assistantText) {
    const messages = normalizeMessages(event.messages);
    const captureMessages = messages.length
      ? messages
      : buildTurnMessages(event.userText, event.assistantText, parseTimestamp(event.startedAt) ?? Date.now());
    await gatewayPost("/capture", {
      user_content: event.userText,
      assistant_content: event.assistantText,
      session_key: event.sessionKey,
      session_id: event.sessionId,
      user_id: userId,
      messages: captureMessages,
      started_at: captureStartedAt(captureMessages, event.startedAt),
    });
    await writeAudit(event, "capture", { messages: captureMessages.length });
    return;
  }

  if (event.type === "session_end") {
    const transcriptMessages = await readTranscriptMessages(event.transcriptPath);
    const cached = await recallPrompt(event);
    const userText =
      cached?.prompt ||
      latestByRole(transcriptMessages, "user");
    const assistantText =
      event.assistantText ||
      latestByRole(transcriptMessages, "assistant");
    if (userText && assistantText) {
      const cachedMessages = normalizeMessages(cached?.messages, parseTimestamp(cached?.startedAt) ?? Number(cached?.updatedAt || Date.now()));
      const captureMessages = transcriptMessages.length
        ? transcriptMessages
        : cachedMessages.length
          ? cachedMessages
          : buildTurnMessages(userText, assistantText, parseTimestamp(cached?.updatedAt) ?? Date.now());
      await gatewayPost("/capture", {
        user_content: userText,
        assistant_content: assistantText,
        session_key: event.sessionKey,
        session_id: event.sessionId,
        user_id: userId,
        messages: captureMessages,
        started_at: captureStartedAt(captureMessages, event.startedAt ?? cached?.startedAt),
      });
      await writeAudit(event, "capture", { messages: captureMessages.length });
      return;
    }
  }

  await gatewayPost("/session/end", {
    session_key: event.sessionKey,
    user_id: userId,
  });
  await writeAudit(event, "session_end");
}

main().catch((err) => {
  console.error(`[memory-tencentdb-hook] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
