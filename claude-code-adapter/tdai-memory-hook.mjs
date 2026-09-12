#!/usr/bin/env node

/**
 * Claude Code command-hook adapter for TencentDB Agent Memory.
 *
 * The hook keeps Claude-specific parsing here and delegates the common
 * recall/capture/session-end lifecycle to adapter-sdk/node.
 */

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  FileTurnStateStore,
  MemoryAdapterRuntime,
  TdaiGatewayClient,
} from "../adapter-sdk/node/index.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const STATE_DIR = process.env.TDAI_CLAUDE_CODE_STATE_DIR
  ? path.resolve(process.env.TDAI_CLAUDE_CODE_STATE_DIR)
  : path.join(os.homedir(), ".memory-tencentdb", "claude-code");
const STATE_FILE = path.join(STATE_DIR, "turn-state.json");

function log(message) {
  if (process.env.TDAI_CLAUDE_CODE_DEBUG === "1") {
    console.error(`[tdai-claude-code] ${message}`);
  }
}

function warn(message) {
  console.error(`[tdai-claude-code] ${message}`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function requestTimeoutMs() {
  const raw = process.env.TDAI_CLAUDE_CODE_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function sessionKey(input) {
  const sessionId = stringField(input, "session_id") || stringField(input, "sessionId");
  if (sessionId) return sessionId;

  const transcript = stringField(input, "transcript_path") || stringField(input, "transcriptPath");
  if (transcript) {
    return `claude-code:${createHash("sha256").update(transcript).digest("hex").slice(0, 16)}`;
  }

  const cwd = stringField(input, "cwd") || process.cwd();
  return `claude-code:${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}`;
}

function userId() {
  return process.env.TDAI_CLAUDE_CODE_USER_ID || process.env.USER || process.env.USERNAME || "default_user";
}

function hookName(input) {
  return stringField(input, "hook_event_name") || stringField(input, "hookEventName") || "";
}

function stringField(obj, key) {
  const value = obj?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function currentPrompt(input) {
  return stringField(input, "prompt") || stringField(input, "user_prompt") || stringField(input, "userPrompt");
}

function assistantMessage(input) {
  return stringField(input, "last_assistant_message") || stringField(input, "lastAssistantMessage") || stringField(input, "assistant_response");
}

function outputJson(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

function passThrough() {
  // Exit 0 with no stdout means "no decision"; Claude Code continues through
  // the normal lifecycle without adding hook output to the transcript.
}

class ClaudeCodePlatformAdapter {
  event(input) {
    switch (hookName(input)) {
      case "UserPromptSubmit":
        return "recall";
      case "Stop":
        return "capture";
      case "SessionEnd":
        return "session_end";
      default:
        log(`Ignoring hook event: ${hookName(input) || "(missing)"}`);
        return "ignore";
    }
  }

  session(input) {
    const key = sessionKey(input);
    return {
      sessionKey: key,
      sessionId: key,
      userId: userId(input),
    };
  }

  recallQuery(input) {
    return currentPrompt(input);
  }

  async beforeRecall(input, { stateStore, session, query }) {
    await stateStore.mergeSession(session.sessionKey, {
      lastUserPrompt: query,
      lastPromptAt: new Date().toISOString(),
    });
  }

  injectRecall(context) {
    outputJson({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `## TencentDB Agent Memory\n${context}`,
      },
    });
  }

  async completedTurn(input, { stateStore, session }) {
    const assistantText = assistantMessage(input);
    const state = await stateStore.readSession(session.sessionKey);
    const lastUserPrompt = state.lastUserPrompt;

    if (!lastUserPrompt || !assistantText) {
      log(`Skip capture: userPrompt=${Boolean(lastUserPrompt)} assistant=${Boolean(assistantText)}`);
      return null;
    }

    return {
      userText: lastUserPrompt,
      assistantText,
      sessionId: session.sessionId,
      userId: session.userId,
      messages: [
        { role: "user", content: lastUserPrompt },
        { role: "assistant", content: assistantText },
      ],
    };
  }

  async afterCapture(_result, _input, { stateStore, session }) {
    await stateStore.updateSession(session.sessionKey, (state) => {
      delete state.lastUserPrompt;
      return {
        ...state,
        lastCaptureAt: new Date().toISOString(),
      };
    });
  }

  async afterSessionEnd(_result, _input, { stateStore, session }) {
    await stateStore.deleteSession(session.sessionKey);
  }

  passThrough() {
    return passThrough();
  }
}

async function main() {
  const stdin = await readStdin();
  if (!stdin.trim()) {
    passThrough();
    return;
  }

  let input;
  try {
    input = JSON.parse(stdin);
  } catch (err) {
    warn(`Invalid hook JSON: ${err instanceof Error ? err.message : String(err)}`);
    passThrough();
    return;
  }

  const runtime = new MemoryAdapterRuntime({
    platform: new ClaudeCodePlatformAdapter(),
    client: new TdaiGatewayClient({ timeoutMs: requestTimeoutMs() }),
    stateStore: new FileTurnStateStore(STATE_FILE, { logger: { warn } }),
    logger: { warn },
  });

  await runtime.handle(input);
}

main().catch((err) => {
  warn(`Unexpected failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  passThrough();
});
