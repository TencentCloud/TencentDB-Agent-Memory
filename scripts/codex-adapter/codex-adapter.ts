#!/usr/bin/env node
/**
 * Codex adapter CLI for TencentDB Agent Memory.
 *
 * This is intentionally thin: Codex hooks or local scripts call this binary,
 * and the binary talks to the host-neutral Gateway. Keeping Codex on the HTTP
 * boundary avoids coupling this package to Codex internals while still giving
 * Codex sessions recall, capture, and search capabilities.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

interface AdapterOptions {
  command: string;
  gatewayUrl: string;
  apiKey?: string;
  sessionKey: string;
  sessionId?: string;
  query?: string;
  user?: string;
  assistant?: string;
  input?: string;
  output?: string;
  limit?: number;
  type?: string;
  scene?: string;
  json: boolean;
}

interface HttpErrorBody {
  error?: string;
  message?: string;
}

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
const DEFAULT_SESSION_FILE = path.join(homedir(), ".memory-tencentdb", "codex-adapter-session.json");

function printUsage(): never {
  console.log(`TencentDB Agent Memory Codex adapter

Usage:
  memory-tencentdb-codex recall --query <text> [--session-key <key>]
  memory-tencentdb-codex capture --user <text> --assistant <text> [--session-key <key>]
  memory-tencentdb-codex search --query <text> [--limit 5] [--type persona]
  memory-tencentdb-codex conversation-search --query <text> [--limit 5]

Options:
  --gateway-url <url>   Gateway URL (default: ${DEFAULT_GATEWAY_URL}; env TDAI_GATEWAY_URL)
  --api-key <key>       Gateway API key (env TDAI_GATEWAY_API_KEY)
  --session-key <key>   Stable Codex conversation key (env CODEX_SESSION_ID or auto-generated)
  --session-id <id>     Optional sub-session id
  --input <file>        Read user/query text from file, or '-' for stdin
  --output <file>       Write response text to file
  --json                Print raw JSON response
`);
  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function readText(value?: string, input?: string): Promise<string | undefined> {
  if (value != null) return value;
  if (!input) return undefined;
  if (input === "-") return (await readStdin()).trim();
  return readFileSync(input, "utf8").trim();
}

function getOrCreateSessionKey(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();

  const envSession = process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.TDAI_SESSION_KEY;
  if (envSession && envSession.trim()) return `codex:${envSession.trim()}`;

  const workspace = process.env.CODEX_WORKSPACE || process.cwd();
  const digest = createHash("sha256").update(workspace).digest("hex").slice(0, 16);

  try {
    if (existsSync(DEFAULT_SESSION_FILE)) {
      const parsed = JSON.parse(readFileSync(DEFAULT_SESSION_FILE, "utf8")) as { sessionKey?: string; workspaceHash?: string };
      if (parsed.workspaceHash === digest && parsed.sessionKey) return parsed.sessionKey;
    }
    mkdirSync(path.dirname(DEFAULT_SESSION_FILE), { recursive: true });
    const sessionKey = `codex:${digest}:${randomUUID()}`;
    writeFileSync(DEFAULT_SESSION_FILE, JSON.stringify({ workspaceHash: digest, sessionKey }, null, 2));
    return sessionKey;
  } catch {
    return `codex:${digest}`;
  }
}

function parseOptions(): AdapterOptions {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") printUsage();

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      "gateway-url": { type: "string" },
      "api-key": { type: "string" },
      "session-key": { type: "string" },
      "session-id": { type: "string" },
      query: { type: "string" },
      user: { type: "string" },
      assistant: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
      limit: { type: "string" },
      type: { type: "string" },
      scene: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) printUsage();

  return {
    command,
    gatewayUrl: String(values["gateway-url"] ?? process.env.TDAI_GATEWAY_URL ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, ""),
    apiKey: values["api-key"] ?? process.env.TDAI_GATEWAY_API_KEY,
    sessionKey: getOrCreateSessionKey(values["session-key"]),
    sessionId: values["session-id"],
    query: values.query,
    user: values.user,
    assistant: values.assistant,
    input: values.input,
    output: values.output,
    limit: values.limit ? Number(values.limit) : undefined,
    type: values.type,
    scene: values.scene,
    json: Boolean(values.json),
  };
}

async function postJson<T>(opts: AdapterOptions, endpoint: string, body: unknown): Promise<T> {
  const response = await fetch(`${opts.gatewayUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as T) : ({} as T);
  if (!response.ok) {
    const errorBody = parsed as HttpErrorBody;
    throw new Error(errorBody.error ?? errorBody.message ?? `Gateway request failed with HTTP ${response.status}`);
  }
  return parsed;
}

function writeOutput(opts: AdapterOptions, text: string): void {
  if (opts.output) {
    writeFileSync(opts.output, text, "utf8");
    return;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function main(): Promise<void> {
  const opts = parseOptions();

  switch (opts.command) {
    case "recall": {
      const query = await readText(opts.query, opts.input);
      if (!query) throw new Error("recall requires --query or --input");
      const result = await postJson<{ context?: string; strategy?: string; memory_count?: number }>(opts, "/recall", {
        query,
        session_key: opts.sessionKey,
        session_id: opts.sessionId,
      });
      writeOutput(opts, opts.json ? JSON.stringify(result, null, 2) : (result.context ?? ""));
      break;
    }
    case "capture": {
      const user = await readText(opts.user, opts.input);
      const assistant = opts.assistant;
      if (!user || !assistant) throw new Error("capture requires --user/--input and --assistant");
      const result = await postJson(opts, "/capture", {
        user_content: user,
        assistant_content: assistant,
        session_key: opts.sessionKey,
        session_id: opts.sessionId,
        messages: [
          { role: "user", content: user },
          { role: "assistant", content: assistant },
        ],
      });
      writeOutput(opts, JSON.stringify(result, null, 2));
      break;
    }
    case "search": {
      const query = await readText(opts.query, opts.input);
      if (!query) throw new Error("search requires --query or --input");
      const result = await postJson<{ results?: string; total?: number; strategy?: string }>(opts, "/search/memories", {
        query,
        limit: opts.limit,
        type: opts.type,
        scene: opts.scene,
      });
      writeOutput(opts, opts.json ? JSON.stringify(result, null, 2) : (result.results ?? ""));
      break;
    }
    case "conversation-search": {
      const query = await readText(opts.query, opts.input);
      if (!query) throw new Error("conversation-search requires --query or --input");
      const result = await postJson<{ results?: string; total?: number }>(opts, "/search/conversations", {
        query,
        limit: opts.limit,
        session_key: opts.sessionKey,
      });
      writeOutput(opts, opts.json ? JSON.stringify(result, null, 2) : (result.results ?? ""));
      break;
    }
    default:
      throw new Error(`Unknown command: ${opts.command}`);
  }
}

main().catch((err) => {
  console.error(`[memory-tencentdb-codex] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
