#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gatewayPost } from "./gateway-client.js";

const platform = process.env.MEMORY_TENCENTDB_HOOK_PLATFORM || "generic";
const eventName = process.env.MEMORY_TENCENTDB_HOOK_EVENT || "";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CAPTURE_CLAIM_STALE_MS = 60_000;
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

function normalizeMessage(candidate) {
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
  return { role, content };
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
      const direct = normalizeMessage(entry);
      if (direct) {
        messages.push(direct);
        continue;
      }
      const nested = normalizeMessage(entry.message);
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
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
  const started = Date.now();

  while (true) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
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

function pruneCache(cache, now = Date.now()) {
  for (const [key, value] of Object.entries(cache)) {
    if (!value || typeof value !== "object" || now - Number(value.updatedAt || 0) > CACHE_MAX_AGE_MS) {
      delete cache[key];
    }
  }
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
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cache), { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, file);
}

async function rememberPrompt(event) {
  if (!event.prompt) return;
  await withCacheLock(async () => {
    const now = Date.now();
    const cache = await loadCache();
    pruneCache(cache, now);
    cache[cacheKey(event)] = {
      prompt: event.prompt,
      sessionKey: event.sessionKey,
      sessionId: event.sessionId,
      turnId: event.turnId,
      updatedAt: now,
    };
    await saveCache(cache);
  });
}

async function recallPrompt(event) {
  const cache = await loadCache();
  const exact = cache[cacheKey(event)];
  if (exact?.prompt && Date.now() - Number(exact.updatedAt || 0) <= CACHE_MAX_AGE_MS) return exact;

  const candidates = Object.values(cache)
    .filter((entry) => (
      entry?.prompt &&
      entry?.sessionKey === event.sessionKey &&
      Date.now() - Number(entry.updatedAt || 0) <= CACHE_MAX_AGE_MS
    ))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return candidates[0];
}

function captureClaimKey(event, userText, assistantText, nonce) {
  const identity = event.turnId || nonce || shortHash(`${userText}\u001f${assistantText}`);
  return `capture:${shortHash([platform, event.sessionKey, event.sessionId, identity].join("\u001f"))}`;
}

async function claimCapture(event, userText, assistantText, nonce) {
  const key = captureClaimKey(event, userText, assistantText, nonce);
  return withCacheLock(async () => {
    const cache = await loadCache();
    pruneCache(cache);
    const existing = cache[key];
    const pendingIsStale =
      existing?.kind === "capture_claim" &&
      existing?.status === "pending" &&
      Date.now() - Number(existing.updatedAt || 0) > CAPTURE_CLAIM_STALE_MS;
    if (existing && !pendingIsStale) return { claimed: false, key };
    cache[key] = {
      kind: "capture_claim",
      status: "pending",
      updatedAt: Date.now(),
    };
    await saveCache(cache);
    return { claimed: true, key };
  });
}

async function finishCaptureClaim(key, succeeded) {
  await withCacheLock(async () => {
    const cache = await loadCache();
    const claim = cache[key];
    if (claim?.kind !== "capture_claim") return;
    if (succeeded) {
      cache[key] = { ...claim, status: "complete", updatedAt: Date.now() };
    } else {
      delete cache[key];
    }
    await saveCache(cache);
  });
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

function appendContextBlock(context, block) {
  const current = String(context || "").trim();
  const addition = String(block || "").trim();
  if (!addition || current.includes(addition)) return current;
  return current ? `${current}\n\n${addition}` : addition;
}

async function searchConversationFallback(event) {
  const limit = 3;
  const scoped = await gatewayPost("/search/conversations", {
    query: event.prompt,
    limit,
    session_key: event.sessionKey,
  });
  if (Number(scoped?.total || 0) > 0 || !envFlag("MEMORY_TENCENTDB_GLOBAL_L0_FALLBACK")) {
    return { result: scoped, scope: "session" };
  }
  const global = await gatewayPost("/search/conversations", {
    query: event.prompt,
    limit,
  });
  return { result: global, scope: "global" };
}

async function recallContext(event, userId) {
  const recallRequest = gatewayPost("/recall", {
    query: event.prompt,
    session_key: event.sessionKey,
    user_id: userId,
  });
  const l0Request = envFlag("MEMORY_TENCENTDB_DISABLE_L0_RECALL")
    ? undefined
    : searchConversationFallback(event);
  const [recall, l0] = await Promise.allSettled([
    recallRequest,
    l0Request ?? Promise.resolve(undefined),
  ]);

  let context = recall.status === "fulfilled" && typeof recall.value?.context === "string"
    ? recall.value.context
    : "";
  let l0Scope;
  if (l0.status === "fulfilled" && l0.value) {
    const results = typeof l0.value.result?.results === "string"
      ? l0.value.result.results.trim()
      : "";
    if (Number(l0.value.result?.total || 0) > 0 && results) {
      l0Scope = l0.value.scope;
      context = appendContextBlock(
        context,
        `Relevant prior conversation memory from memory-tencentdb (${l0Scope}-scoped):\n\n${results}`,
      );
    }
  }

  if (recall.status === "rejected" && (l0.status === "rejected" || !context)) {
    throw recall.reason;
  }
  return {
    context,
    l0Scope,
    recallError: recall.status === "rejected" ? recall.reason : undefined,
    l0Error: l0.status === "rejected" ? l0.reason : undefined,
  };
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
  if (lowerEvent.includes("userpromptsubmit") || lowerEvent.includes("prompt")) {
    return { type: "before_prompt", prompt, sessionKey, sessionId, turnId, transcriptPath };
  }

  if (lowerEvent.includes("stop") || lowerEvent.includes("session_end")) {
    if (userText && assistantText) {
      return { type: "turn_committed", userText, assistantText, sessionKey, sessionId, turnId, transcriptPath };
    }
    return { type: "session_end", sessionKey, sessionId, turnId, transcriptPath, assistantText };
  }

  if (userText && assistantText) {
    return { type: "turn_committed", userText, assistantText, sessionKey, sessionId, turnId, transcriptPath };
  }
  if (prompt) {
    return { type: "before_prompt", prompt, sessionKey, sessionId, turnId, transcriptPath };
  }
  return { type: "session_end", sessionKey, sessionId, turnId, transcriptPath };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function captureTurn(event, userText, assistantText, userId, nonce) {
  const claim = await claimCapture(event, userText, assistantText, nonce);
  if (!claim.claimed) {
    await writeAudit(event, "capture_skipped_duplicate");
    return;
  }

  try {
    const capturedAt = Date.now();
    await gatewayPost("/capture", {
      user_content: userText,
      assistant_content: assistantText,
      session_key: event.sessionKey,
      session_id: event.sessionId,
      user_id: userId,
      messages: [
        { role: "user", content: userText, timestamp: capturedAt },
        { role: "assistant", content: assistantText, timestamp: capturedAt },
      ],
      started_at: capturedAt - 1,
    });
    await finishCaptureClaim(claim.key, true);
    await writeAudit(event, "capture");
  } catch (error) {
    await finishCaptureClaim(claim.key, false);
    throw error;
  }
}

async function main() {
  const input = await readStdin();
  const payload = input.trim() ? JSON.parse(input) : {};
  const event = normalizeHookPayload(payload);
  const userId = process.env.MEMORY_TENCENTDB_USER_ID || undefined;

  if (event.type === "before_prompt" && event.prompt) {
    try {
      await rememberPrompt(event);
    } catch (error) {
      await writeAudit(event, "prompt_cache_error", { error: errorMessage(error) });
    }
    const result = await recallContext(event, userId);
    await writeAudit(event, "recall", {
      context_chars: typeof result.context === "string" ? result.context.length : 0,
      l0_scope: result.l0Scope,
      recall_error: result.recallError ? errorMessage(result.recallError) : undefined,
      l0_error: result.l0Error ? errorMessage(result.l0Error) : undefined,
    });
    writeAdditionalContext("UserPromptSubmit", result.context);
    return;
  }

  if (event.type === "turn_committed" && event.userText && event.assistantText) {
    const cached = await recallPrompt(event);
    await captureTurn(event, event.userText, event.assistantText, userId, cached?.updatedAt);
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
      await captureTurn(event, userText, assistantText, userId, cached?.updatedAt);
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
