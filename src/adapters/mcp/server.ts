/**
 * TDAI MCP server — exposes the four-layer memory engine to any MCP host
 * (Claude Code, Codex, Cursor, Cline, Windsurf, …) over stdio.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout, per the MCP
 * stdio transport spec. No MCP framework dependency — the same "native
 * primitives only" philosophy the Gateway uses for HTTP (`node:http`, no
 * Express). All protocol logic lives in `protocol.ts`; this file is just the
 * byte plumbing plus a `main()` that builds the adapter from the environment.
 *
 * CRITICAL: stdout is the protocol channel. Everything diagnostic goes to
 * stderr — a single stray `console.log` would corrupt the JSON-RPC stream.
 *
 * Run it:
 *   TDAI_GATEWAY_URL=http://127.0.0.1:8420 npx tsx src/adapters/mcp/server.ts
 * or wire it into an MCP host — see `src/adapters/mcp/README.md`.
 */

import { McpDispatcher } from "./protocol.js";
import type { McpServerInfo } from "./protocol.js";
import { GatewayMemoryAdapter } from "../../sdk/memory-adapter.js";
import type { MemoryAdapter } from "../../sdk/memory-adapter.js";
import { buildMemoryTools } from "../../sdk/tools.js";
import type { BuildMemoryToolsOptions } from "../../sdk/tools.js";

const SERVER_INFO: McpServerInfo = { name: "tdai-memory", version: "0.1.0" };

const INSTRUCTIONS =
  "TDAI four-layer memory (L0 conversation → L1 memory → L2 scene → L3 persona). " +
  "Use tdai_memory_search to recall structured facts about the user, " +
  "tdai_conversation_search for raw past dialogue, tdai_recall to prime a reply " +
  "with known context, and tdai_capture to persist an important exchange.";

// ============================
// Stdio transport
// ============================

/** Minimal duplex-ish stream surface, so tests can inject fakes. */
export interface StdioStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log: (message: string) => void;
}

export interface StdioMcpServerOptions {
  dispatcher: McpDispatcher;
  streams?: Partial<StdioStreams>;
}

export class StdioMcpServer {
  private readonly dispatcher: McpDispatcher;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly log: (message: string) => void;
  private buffer = "";
  /** Serializes writes so out-of-order async tool calls don't interleave lines. */
  private writeChain: Promise<void> = Promise.resolve();
  /** In-flight request handlers, so shutdown can drain them before exiting. */
  private readonly pending = new Set<Promise<void>>();

  constructor(opts: StdioMcpServerOptions) {
    this.dispatcher = opts.dispatcher;
    this.input = opts.streams?.input ?? process.stdin;
    this.output = opts.streams?.output ?? process.stdout;
    this.log = opts.streams?.log ?? ((m) => process.stderr.write(`[tdai-mcp] ${m}\n`));
  }

  /** Attach stream handlers and begin serving. Resolves when input closes. */
  start(): Promise<void> {
    this.log(`serving over stdio (server ${SERVER_INFO.name}@${SERVER_INFO.version})`);
    if (typeof (this.input as NodeJS.ReadStream).setEncoding === "function") {
      (this.input as NodeJS.ReadStream).setEncoding("utf8");
    }

    return new Promise<void>((resolve) => {
      const shutdown = async (reason: string) => {
        this.log(reason);
        // Drain in-flight handlers, then all queued writes, so a response is
        // never truncated when stdin closes mid-request.
        await Promise.allSettled([...this.pending]);
        await this.writeChain;
        resolve();
      };
      this.input.on("data", (chunk: string | Buffer) => this.onData(chunk.toString()));
      this.input.on("end", () => void shutdown("input stream closed; draining and shutting down"));
      this.input.on("error", (err: Error) => void shutdown(`input stream error: ${err.message}`));
    });
  }

  /** Buffer incoming bytes and dispatch each complete newline-terminated line. */
  private onData(text: string): void {
    this.buffer += text;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line) this.dispatchLine(line);
    }
  }

  /** Parse one line, hand it to the dispatcher, and enqueue the response. */
  private dispatchLine(line: string): void {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      // Parse error → JSON-RPC error with null id (we have no id to echo).
      this.enqueueWrite({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    // Handle the request asynchronously; responses are serialized by the chain.
    // Track the handler in `pending` so shutdown can await it before exiting.
    const task = this.dispatcher
      .handle(request as never)
      .then((response) => {
        if (response) this.enqueueWrite(response);
      })
      .catch((err: unknown) => {
        this.log(`dispatch failure: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  /** Serialize writes; each JSON-RPC message occupies exactly one line. */
  private enqueueWrite(message: unknown): void {
    const payload = JSON.stringify(message) + "\n";
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          this.output.write(payload, () => resolve());
        }),
    );
  }
}

// ============================
// Factory
// ============================

export interface CreateMemoryMcpServerOptions {
  /** Provide a custom adapter (e.g. embedded). Defaults to a Gateway adapter from env. */
  adapter?: MemoryAdapter;
  /** Tool-surface options (session key, which tools to expose). */
  tools?: BuildMemoryToolsOptions;
  streams?: Partial<StdioStreams>;
}

/**
 * Build a fully-wired stdio MCP server: env-configured Gateway adapter →
 * neutral memory tools → MCP dispatcher → stdio transport.
 */
export function createMemoryMcpServer(opts: CreateMemoryMcpServerOptions = {}): StdioMcpServer {
  const adapter = opts.adapter ?? GatewayMemoryAdapter.fromEnv();
  const tools = buildMemoryTools(adapter, opts.tools);
  const dispatcher = new McpDispatcher({
    tools,
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    logger: opts.streams?.log,
  });
  return new StdioMcpServer({ dispatcher, streams: opts.streams });
}

// ============================
// CLI entry point
// ============================

/** Build the env-configured server and serve until stdin closes. */
export async function runMain(): Promise<void> {
  const server = createMemoryMcpServer({
    tools: { sessionKey: process.env.TDAI_MCP_SESSION_KEY || "mcp-default" },
  });
  await server.start();
  process.exit(0);
}

// Auto-run when executed directly via `tsx src/adapters/mcp/server.ts`.
// The `bin/tdai-mcp.mjs` launcher instead imports and calls runMain() itself.
const entry = process.argv[1] ?? "";
if (entry.endsWith("server.ts") || entry.endsWith("server.js")) {
  runMain().catch((err) => {
    process.stderr.write(`[tdai-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
