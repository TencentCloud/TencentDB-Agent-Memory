/**
 * claude-code-capture — CLI entry point for Claude Code postMessage hook.
 *
 * Called by Claude Code after each LLM turn. Reads the completed
 * conversation turn and persists it to the memory store (L0 recording),
 * then triggers the extraction pipeline (L1→L2→L3) if conditions are met.
 *
 * ─── Usage ─────────────────────────────────────────────────────────────────
 *
 * Via settings.json hook:
 * ```json
 * { "hooks": { "postMessage": [{ "matcher": "*", "run": "npx memory-tdai claude-code-capture" }] } }
 * ```
 *
 * Direct invocation:
 * ```bash
 * echo '{"messages":[...],"sessionKey":"abc123"}' | npx memory-tdai claude-code-capture
 * npx memory-tdai claude-code-capture --session-key abc123 --messages-file turn.json
 * ```
 *
 * ─── I/O ───────────────────────────────────────────────────────────────────
 *
 * Reads turn data from stdin (JSON). Writes a brief JSON status to stdout:
 * ```json
 * { "status": "captured", "l0Recorded": 2, "sessionKey": "abc123" }
 * ```
 */

import fs from "node:fs";
import { ClaudeCodeAdapter } from "./adapter.js";

const TAG = "[claude-code-capture]";

interface CaptureInput {
  /** All messages in the turn (user + assistant + tool results). */
  messages: unknown[];
  /** Session identifier for memory scoping. */
  sessionKey: string;
  /** Optional sub-session identifier. */
  sessionId?: string;
  /** Whether the turn completed successfully. */
  success?: boolean;
  /** Optional path to write the capture result to. */
  outputPath?: string;
}

interface CaptureOutput {
  status: "captured" | "skipped" | "error";
  l0Recorded: number;
  schedulerNotified: boolean;
  sessionKey: string;
  error?: string;
}

/**
 * Main capture entry point.
 *
 * Reads turn data from stdin or args, captures it via ClaudeCodeAdapter,
 * and writes a status result to stdout.
 *
 * Uses ClaudeCodeAdapter directly (which wraps GatewayMemoryClient)
 * instead of the old MemoryPlugin + adapter pattern.
 */
export async function claudeCodeCapture(): Promise<void> {
  const input = await readCaptureInput();

  if (!input.sessionKey) {
    logError("Missing sessionKey");
    console.log(JSON.stringify({ status: "error", error: "Missing sessionKey" } satisfies CaptureOutput));
    process.exit(1);
  }

  if (!input.messages || !Array.isArray(input.messages) || input.messages.length === 0) {
    logWarn("No messages to capture, skipping");
    console.log(JSON.stringify({
      status: "skipped",
      l0Recorded: 0,
      schedulerNotified: false,
      sessionKey: input.sessionKey,
    } satisfies CaptureOutput));
    process.exit(0);
  }

  const adapter = new ClaudeCodeAdapter({
    logger: createLogger(),
  });

  try {
    // Extract user text and assistant text from messages
    const { userText, assistantText } = extractTurnText(input.messages);

    await adapter.capture({
      userText,
      assistantText,
      messages: input.messages,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      success: input.success ?? true,
    });

    const output: CaptureOutput = {
      status: "captured",
      l0Recorded: 1,
      schedulerNotified: true,
      sessionKey: input.sessionKey,
    };

    logInfo(`Capture complete: session=${input.sessionKey}`);

    // Write result to stdout or file
    const outputStr = JSON.stringify(output);
    if (input.outputPath) {
      fs.writeFileSync(input.outputPath, outputStr, "utf-8");
      logInfo(`Result written to ${input.outputPath}`);
    } else {
      console.log(outputStr);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError(`Capture failed: ${errMsg}`);

    const output: CaptureOutput = {
      status: "error",
      l0Recorded: 0,
      schedulerNotified: false,
      sessionKey: input.sessionKey,
      error: errMsg,
    };
    console.log(JSON.stringify(output));
    process.exit(1);
  }
}

// ============================
// Input helpers
// ============================

async function readCaptureInput(): Promise<CaptureInput> {
  const args = parseArgs(process.argv.slice(2));

  // Check CLI args for messages file
  if (args.messagesFile) {
    try {
      const data = fs.readFileSync(args.messagesFile as string, "utf-8");
      const parsed = JSON.parse(data);
      return {
        messages: parsed.messages ?? parsed,
        sessionKey: (args.sessionKey as string) || parsed.sessionKey || process.env.CLAUDE_SESSION_KEY || "default",
        sessionId: (args.sessionId as string) || parsed.sessionId,
        success: parsed.success !== false,
        outputPath: args.outputPath as string | undefined,
      };
    } catch (err) {
      logError(`Failed to read messages file: ${err}`);
    }
  }

  // Check env vars
  const envSessionKey = process.env.CLAUDE_SESSION_KEY;
  const envMessagesPath = process.env.CLAUDE_MESSAGES_FILE;
  if (envMessagesPath) {
    try {
      const data = fs.readFileSync(envMessagesPath, "utf-8");
      const parsed = JSON.parse(data);
      return {
        messages: parsed.messages ?? parsed,
        sessionKey: envSessionKey || parsed.sessionKey || "default",
        sessionId: parsed.sessionId,
        success: parsed.success !== false,
      };
    } catch {
      // Fall through to stdin
    }
  }

  // Read from stdin
  const stdin = await readStdin();
  if (stdin) {
    try {
      const parsed = JSON.parse(stdin) as CaptureInput;
      return {
        messages: parsed.messages ?? [],
        sessionKey: parsed.sessionKey || envSessionKey || "default",
        sessionId: parsed.sessionId,
        success: parsed.success !== false,
        outputPath: parsed.outputPath,
      };
    } catch {
      logError("Invalid JSON from stdin");
    }
  }

  // Fallback
  return {
    messages: [],
    sessionKey: envSessionKey || "default",
    success: true,
  };
}

/**
 * Extract user and assistant text from a message array for capture.
 * Looks for the last user message and last assistant message.
 */
function extractTurnText(messages: unknown[]): { userText: string; assistantText: string } {
  let userText = "";
  let assistantText = "";

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = String(m.role ?? "");
    const content = extractTextContent(m.content);

    if (role === "user" && content) {
      userText = content;
    } else if (role === "assistant" && content) {
      assistantText = content;
    }
  }

  return { userText, assistantText };
}

/**
 * Extract plain text from a message content field which may be
 * a string, an array of content parts, or something else.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        args[key] = value;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(Buffer.concat(chunks).toString("utf-8")), 200);
  });
}

// ============================
// Logging
// ============================

function createLogger() {
  return {
    debug: (msg: string) => process.env.DEBUG?.includes("memory") && console.error(`${TAG} ${msg}`),
    info: (msg: string) => console.error(`${TAG} ${msg}`),
    warn: (msg: string) => console.error(`${TAG} ${msg}`),
    error: (msg: string) => console.error(`${TAG} ${msg}`),
  };
}

function logInfo(msg: string): void {
  console.error(`${TAG} ${msg}`);
}

function logWarn(msg: string): void {
  console.error(`${TAG} WARN: ${msg}`);
}

function logError(msg: string): void {
  console.error(`${TAG} ERROR: ${msg}`);
}

// ─── CLI entry ────────────────────────────────────────────────────────────

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalized = entry.replace(/\\/g, "/");
  return normalized.endsWith("cli-capture.ts") ||
         normalized.endsWith("cli-capture.js") ||
         normalized.endsWith("cli-capture.mjs") ||
         normalized.endsWith("claude-code-capture");
}

if (isDirectEntry()) {
  claudeCodeCapture().catch((err) => {
    console.error(`${TAG} Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
