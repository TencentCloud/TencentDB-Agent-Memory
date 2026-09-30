#!/usr/bin/env node

import {
  GatewayClient,
  boundedInteger,
  boundedText,
  envEnabled,
  makeSessionKey,
  optionalUserId
} from "./gateway-client.mjs";
import {
  abandonClaim,
  claimPrompt,
  clearStableContext,
  completeClaim,
  rememberPrompt,
  takeChangedStableContext,
  waitForSessionIdle
} from "./pending-turns.mjs";

const MAX_HOOK_INPUT_CHARS = 4_000_000;
const MAX_ASSISTANT_CHARS = 2_000_000;
const MAX_HOOK_OUTPUT_CHARS = 9_900;

const action = process.argv[2];

try {
  const input = await readHookInput();
  if (action === "recall") {
    await handleRecall(input);
  } else if (action === "capture") {
    await handleCapture(input);
  } else if (action === "session-end") {
    await handleSessionEnd(input);
  } else {
    throw new Error(`Unknown hook action: ${action || "(missing)"}`);
  }
} catch (error) {
  warn(action, error);
  if (action === "recall") writeRecallOutput("");
}

async function handleRecall(input) {
  const sessionId = requiredString(input?.session_id, "session_id", 512);
  const promptId = optionalString(input?.prompt_id, 512);
  const prompt = requiredString(input?.prompt, "prompt", MAX_HOOK_INPUT_CHARS);
  const cwd = optionalString(input?.cwd, 4_096) || process.cwd();

  // Stop does not receive the original user prompt. Persist it before any
  // network request so capture can still succeed if recall is unavailable.
  await rememberPrompt({ sessionId, promptId, prompt });

  if (!envEnabled("TDAI_CLAUDE_AUTO_RECALL", true)) {
    writeRecallOutput("");
    return;
  }

  const client = new GatewayClient();
  const result = await client.recall({
    query: prompt,
    session_key: makeSessionKey(sessionId, cwd),
    user_id: optionalUserId()
  });

  const stable =
    typeof result?.append_system_context === "string"
      ? result.append_system_context
      : typeof result?.context === "string"
        ? result.context
        : "";
  const dynamic =
    typeof result?.prepend_context === "string" ? result.prepend_context : "";
  const changedStable = await takeChangedStableContext(
    sessionId,
    makeStableContextPortable(stable)
  );
  writeRecallOutput([changedStable, dynamic].filter(Boolean).join("\n\n"));
}

async function handleCapture(input) {
  const sessionId = requiredString(input?.session_id, "session_id", 512);
  const promptId = optionalString(input?.prompt_id, 512);
  const cwd = optionalString(input?.cwd, 4_096) || process.cwd();
  const assistant = requiredString(
    input?.last_assistant_message,
    "last_assistant_message",
    MAX_ASSISTANT_CHARS
  );
  const claim = await claimPrompt({
    sessionId,
    promptId
  });
  if (!claim) return;

  if (!envEnabled("TDAI_CLAUDE_AUTO_CAPTURE", true)) {
    await completeClaim(claim);
    return;
  }

  try {
    const client = new GatewayClient();
    const sessionKey = makeSessionKey(sessionId, cwd);
    await client.capture(
      {
        user_content: claim.prompt,
        assistant_content: assistant,
        session_key: sessionKey,
        session_id: sessionKey,
        user_id: optionalUserId(),
        messages: [
          // Deliberately omit timestamps. The Gateway supplies a cold-start
          // cursor one millisecond earlier, and the Core assigns timestamps
          // afterward so both messages pass its strict `timestamp > cursor`.
          { role: "user", content: claim.prompt },
          { role: "assistant", content: assistant }
        ]
      },
      {
        timeoutMs: boundedInteger(
          process.env.TDAI_CLAUDE_CAPTURE_TIMEOUT_MS,
          10_000,
          1_000,
          18_000
        )
      }
    );
    await completeClaim(claim);
  } catch (error) {
    // Do not return a failed prompt to the pending set: a later Stop event
    // could pair it with the wrong assistant response. Preserve a short-lived
    // .failed record for diagnostics and fail open.
    await abandonClaim(claim);
    throw error;
  }
}

async function handleSessionEnd(input) {
  const sessionId = requiredString(input?.session_id, "session_id", 512);
  const cwd = optionalString(input?.cwd, 4_096) || process.cwd();
  const waitMs = boundedInteger(
    process.env.TDAI_CLAUDE_SESSION_END_WAIT_MS,
    15_000,
    0,
    45_000
  );

  // A SessionEnd event can race process shutdown or an externally interrupted
  // Stop. Give any remaining state a bounded opportunity to settle first.
  await waitForSessionIdle(sessionId, waitMs);

  const client = new GatewayClient();
  await client.endSession(
    {
      session_key: makeSessionKey(sessionId, cwd),
      user_id: optionalUserId()
    },
    { timeoutMs: 60_000 }
  );
  await clearStableContext(sessionId);
}

function writeRecallOutput(context) {
  let value = boundedText(context, 9_000);
  let output = serializeRecallOutput(value);
  if (output.length > MAX_HOOK_OUTPUT_CHARS) {
    const overflow = output.length - MAX_HOOK_OUTPUT_CHARS;
    value = `${value.slice(0, Math.max(0, value.length - overflow - 80))}\n\n[Memory context truncated]`;
    output = serializeRecallOutput(value);
  }
  while (output.length > MAX_HOOK_OUTPUT_CHARS && value.length > 0) {
    value = value.slice(0, Math.floor(value.length * 0.9));
    output = serializeRecallOutput(`${value}\n\n[Memory context truncated]`);
  }
  process.stdout.write(output);
}

function serializeRecallOutput(context) {
  if (!context) return "{}";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context
    }
  });
}

async function readHookInput() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.length > MAX_HOOK_INPUT_CHARS) {
      throw new Error("Hook input exceeded the adapter safety limit");
    }
  }
  if (!data.trim()) throw new Error("Hook input was empty");
  return JSON.parse(data);
}

function makeStableContextPortable(context) {
  if (!context) return "";
  return context
    .split(/\r?\n/)
    .map((line) => {
      const pathMatch = line.match(/^### Path:\s*(.+)$/);
      if (pathMatch) {
        const filename = pathMatch[1].trim().split(/[\\/]/).pop() || "unknown";
        return `### Scene: ${filename.replace(/\.md$/i, "")}`;
      }
      return line
        .replace(/\bread_file\b/g, "tdai_memory_search")
        .replace(
          /Path 是 scene block 的绝对路径，可直接使用 tdai_memory_search 读取完整内容/,
          "Scene 是场景名，可通过 tdai_memory_search 的 scene 参数检索相关记忆"
        );
    })
    .join("\n");
}

function requiredString(value, field, maximumChars) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Hook input is missing ${field}`);
  }
  return boundedText(value, maximumChars);
}

function optionalString(value, maximumChars) {
  return typeof value === "string" && value ? boundedText(value, maximumChars) : undefined;
}

function warn(hookAction, error) {
  const code = typeof error?.code === "string" ? ` (${error.code})` : "";
  const message =
    typeof error?.message === "string" ? error.message.slice(0, 500) : "Unknown error";
  process.stderr.write(
    `[tencentdb-agent-memory] ${hookAction || "hook"} failed${code}: ${message}\n`
  );
}
