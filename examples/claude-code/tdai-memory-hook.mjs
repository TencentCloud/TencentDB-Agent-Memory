#!/usr/bin/env node
/**
 * Claude Code hook adapter for TencentDB Agent Memory.
 *
 * Hook mapping:
 * - UserPromptSubmit -> POST /recall, injects recalled context.
 * - Stop             -> POST /capture, records the last user/assistant turn.
 * - SessionEnd       -> POST /session/end, flushes pending extraction work.
 *
 * This script is intentionally dependency-free so it can be copied into
 * .claude/hooks/tdai-memory-hook.mjs in any Claude Code project.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const gatewayUrl = (process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8765").replace(/\/+$/, "");
const apiKey = process.env.TDAI_GATEWAY_API_KEY;
const timeoutMs = Number(process.env.TDAI_GATEWAY_TIMEOUT_MS ?? "30000");
const cacheDir = process.env.TDAI_HOOK_CACHE_DIR
  ?? path.join(os.tmpdir(), "tdai-memory-claude-code");

const input = await readJsonStdin();
const eventName = input.hook_event_name ?? process.env.TDAI_HOOK_EVENT ?? "";
const sessionKey = input.session_id ?? input.sessionId ?? stableSessionFromCwd(input.cwd);

try {
  if (eventName === "UserPromptSubmit") {
    await handleUserPromptSubmit(input, sessionKey);
  } else if (eventName === "Stop") {
    await handleStop(input, sessionKey);
  } else if (eventName === "SessionEnd") {
    await handleSessionEnd(sessionKey);
  }
} catch (err) {
  // Hook failures should never break the host Agent. Log to stderr only.
  console.error(`[tdai-memory-hook] ${err instanceof Error ? err.message : String(err)}`);
}

async function handleUserPromptSubmit(payload, sessionKey) {
  const prompt = firstString(payload.prompt, payload.user_prompt, payload.userPrompt);
  if (!prompt) return;

  await writeCache(sessionKey, {
    session_key: sessionKey,
    user_content: prompt,
    created_at: Date.now(),
  });

  const recalled = await postJson("/recall", {
    query: prompt,
    session_key: sessionKey,
  });

  const context = typeof recalled.context === "string" ? recalled.context.trim() : "";
  if (!context) return;

  writeHookOutput({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `<memory-context>\n${context}\n</memory-context>`,
    },
  });
}

async function handleStop(payload, sessionKey) {
  if (payload.stop_hook_active === true) return;
  if (process.env.TDAI_CAPTURE_ON_STOP === "false") return;

  const cached = await readCache(sessionKey);
  const userContent = cached?.user_content;
  const assistantContent = firstString(
    payload.last_assistant_message,
    payload.assistant_response,
    await readLastAssistantMessage(payload.transcript_path),
  );

  if (!userContent || !assistantContent) return;

  await postJson("/capture", {
    user_content: userContent,
    assistant_content: assistantContent,
    session_key: cached.session_key ?? sessionKey,
    session_id: sessionKey,
    messages: [
      { role: "user", content: userContent },
      { role: "assistant", content: assistantContent },
    ],
  });

  await deleteCache(sessionKey);
}

async function handleSessionEnd(sessionKey) {
  if (!sessionKey) return;
  await postJson("/session/end", { session_key: sessionKey });
}

async function postJson(route, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(`${gatewayUrl}${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(parsed.error ?? `Gateway returned HTTP ${response.status}`);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function writeCache(sessionKey, data) {
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath(sessionKey), JSON.stringify(data), "utf-8");
}

async function readCache(sessionKey) {
  try {
    return JSON.parse(await fs.readFile(cachePath(sessionKey), "utf-8"));
  } catch {
    return undefined;
  }
}

async function deleteCache(sessionKey) {
  try {
    await fs.unlink(cachePath(sessionKey));
  } catch {
    // no-op
  }
}

function cachePath(sessionKey) {
  return path.join(cacheDir, `${safeFilePart(sessionKey)}.json`);
}

function safeFilePart(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

function stableSessionFromCwd(cwd) {
  return cwd ? `claude-code:${cwd}` : "claude-code:default";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

async function readLastAssistantMessage(transcriptPath) {
  if (!transcriptPath) return "";
  try {
    const content = await fs.readFile(transcriptPath, "utf-8");
    const lines = content.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      const parsed = JSON.parse(line);
      const role = parsed.role ?? parsed.message?.role;
      if (role !== "assistant") continue;
      return extractText(parsed.content ?? parsed.message?.content);
    }
  } catch {
    return "";
  }
  return "";
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "string" ? part : part?.text)
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n");
}

function writeHookOutput(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
