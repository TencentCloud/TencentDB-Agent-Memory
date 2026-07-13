/**
 * claude-code-recall — CLI entry point for Claude Code preMessage hook.
 *
 * Called by Claude Code before each LLM turn. Reads the user's message,
 * performs memory recall, and outputs context for prompt injection.
 *
 * ─── Usage ─────────────────────────────────────────────────────────────────
 *
 * Via settings.json hook:
 * ```json
 * { "hooks": { "preMessage": [{ "matcher": "*", "run": "npx memory-tdai claude-code-recall" }] } }
 * ```
 *
 * Direct invocation:
 * ```bash
 * echo '{"text":"user message","sessionKey":"abc123"}' | npx memory-tdai claude-code-recall
 * # Or:
 * npx memory-tdai claude-code-recall --text "user message" --session-key abc123
 * ```
 *
 * ─── Output ─────────────────────────────────────────────────────────────────
 *
 * Writes JSON to stdout with recall context:
 * ```json
 * {
 *   "prependContext": "<relevant-memories>...</relevant-memories>",
 *   "strategy": "hybrid",
 *   "sessionKey": "abc123"
 * }
 * ```
 *
 * Claude Code reads this and injects it into the LLM prompt.
 * When no relevant memories are found, outputs an empty object.
 */

import { ClaudeCodeAdapter } from "./adapter.js";

const TAG = "[claude-code-recall]";

interface RecallInput {
  /** The user's message text. */
  text: string;
  /** Session identifier for memory scoping. */
  sessionKey: string;
  /** Optional user identifier. */
  userId?: string;
}

interface RecallOutput {
  prependContext?: string;
  strategy?: string;
  sessionKey?: string;
}

/**
 * Main recall entry point.
 *
 * Accepts input from stdin (JSON) or command-line arguments.
 * Outputs recall context to stdout as JSON.
 *
 * Uses ClaudeCodeAdapter directly (which wraps GatewayMemoryClient)
 * instead of the old MemoryPlugin + adapter pattern.
 */
export async function claudeCodeRecall(): Promise<void> {
  const input = await readRecallInput();

  if (!input.text || !input.sessionKey) {
    logError("Missing required input: text and sessionKey");
    console.log(JSON.stringify({}));
    process.exit(1);
  }

  const adapter = new ClaudeCodeAdapter({
    logger: createLogger(),
  });

  try {
    const result = await adapter.recall(input.text, input.sessionKey);

    const output: RecallOutput = {
      prependContext: result.prependContext,
      strategy: result.strategy,
      sessionKey: input.sessionKey,
    };

    // Write recall context to stdout for Claude Code to inject
    console.log(JSON.stringify(output));

    logInfo(`Recall complete: strategy=${result.strategy ?? "none"}, ` +
      `prepend=${result.prependContext?.length ?? 0} chars`);
  } catch (err) {
    logError(`Recall failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log(JSON.stringify({})); // Graceful degradation
    process.exit(1);
  }
}

// ============================
// Input helpers
// ============================

async function readRecallInput(): Promise<RecallInput> {
  // Priority: CLI args > env vars > stdin

  const args = parseArgs(process.argv.slice(2));

  // Check CLI args
  if (args.text && args.sessionKey) {
    return {
      text: args.text as string,
      sessionKey: args.sessionKey as string,
      userId: args.userId as string | undefined,
    };
  }

  // Check env vars (set by Claude Code for hooks)
  const envText = process.env.CLAUDE_USER_MESSAGE;
  const envSessionKey = process.env.CLAUDE_SESSION_KEY;
  if (envText && envSessionKey) {
    return {
      text: envText,
      sessionKey: envSessionKey,
      userId: process.env.CLAUDE_USER_ID,
    };
  }

  // Read from stdin (JSON)
  const stdin = await readStdin();
  if (stdin) {
    try {
      const parsed = JSON.parse(stdin) as RecallInput;
      if (parsed.text && parsed.sessionKey) {
        return parsed;
      }
    } catch {
      // Try plain text
      return {
        text: stdin.trim(),
        sessionKey: process.env.CLAUDE_SESSION_KEY || "default",
      };
    }
  }

  // Fallback: create a session key from project identity
  return {
    text: args.text as string || envText || "",
    sessionKey: envSessionKey || "default",
  };
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
    // Timeout: don't hang waiting for stdin
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

function logError(msg: string): void {
  console.error(`${TAG} ERROR: ${msg}`);
}

// ─── CLI entry ────────────────────────────────────────────────────────────

// Only auto-run when this file is the actual entry point (not when imported)
function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalized = entry.replace(/\\/g, "/");
  return normalized.endsWith("cli-recall.ts") ||
         normalized.endsWith("cli-recall.js") ||
         normalized.endsWith("cli-recall.mjs") ||
         normalized.endsWith("claude-code-recall");
}

if (isDirectEntry()) {
  claudeCodeRecall().catch((err) => {
    console.error(`${TAG} Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
