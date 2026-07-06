/**
 * Claude Code adapter — MCP stdio server (`TdaiMcpServer`).
 *
 * Implements the Model Context Protocol subset Claude Code needs to consume
 * memory tools over the stdio transport (spec rev 2025-06-18):
 *
 *   initialize                → capability + version negotiation
 *   notifications/initialized → acknowledged silently
 *   ping                      → {}
 *   tools/list                → the 5 memory tools (tools.ts)
 *   tools/call                → dispatch onto MemoryClient
 *
 * Built on the Adapter SDK: extends `BasePlatformAdapter`, consumes ONLY the
 * `MemoryClient` interface — the same server binary works against a remote
 * Gateway (http transport) or an embedded TdaiCore (in-process transport).
 *
 * stdio discipline: protocol messages are the ONLY bytes on stdout; all
 * logging must go to stderr (see main.ts) or the client's JSON parser breaks.
 * The server itself never calls console.* — it logs through the injected
 * Logger only, and when no logger is injected it defaults to a stderr-only
 * one (never BasePlatformAdapter's stdout console default).
 */

import { createInterface, type Interface } from "node:readline";
import { BasePlatformAdapter } from "../../adapter-sdk/base-platform-adapter.js";
import type { MemoryClient } from "../../adapter-sdk/types.js";
import type { Logger } from "../../core/types.js";
import {
  parseLine,
  serialize,
  successResponse,
  errorResponse,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  type JsonRpcRequest,
} from "./jsonrpc.js";
import { TOOL_DEFINITIONS, dispatchToolCall, UnknownToolError } from "./tools.js";

const TAG = "[tdai-adapter] [mcp]";

/** Protocol revisions this server can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const SERVER_NAME = "tdai-memory";

/**
 * Fallback logger when the host injects none: stderr only, because on the
 * stdio transport any stray stdout byte corrupts the protocol stream —
 * BasePlatformAdapter's console default would write debug/info to stdout.
 */
function defaultStderrLogger(): Logger {
  const write = (level: string, msg: string) => {
    process.stderr.write(`[${level}] ${msg}\n`);
  };
  return {
    debug: (msg: string) => write("debug", msg),
    info: (msg: string) => write("info", msg),
    warn: (msg: string) => write("warn", msg),
    error: (msg: string) => write("error", msg),
  };
}

// ============================
// Options
// ============================

export interface TdaiMcpServerOptions {
  client: MemoryClient;
  /** Default session key applied when a tool call omits `session_key`. */
  sessionKey: string;
  userId?: string;
  /** Message source. Default: `process.stdin`. */
  input?: NodeJS.ReadableStream;
  /** Response sink. Default: `process.stdout`. */
  output?: NodeJS.WritableStream;
  logger?: Logger;
  /** Reported in `serverInfo.version`. */
  serverVersion?: string;
}

// ============================
// TdaiMcpServer
// ============================

export class TdaiMcpServer extends BasePlatformAdapter {
  readonly platformName = "claude-code";

  private readonly sessionKey: string;
  private readonly userId?: string;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly serverVersion: string;
  private rl?: Interface;
  /** Resolves when the input stream closes (start() awaits it). */
  private done?: Promise<void>;

  constructor(opts: TdaiMcpServerOptions) {
    super({ client: opts.client, logger: opts.logger ?? defaultStderrLogger() });
    this.sessionKey = opts.sessionKey;
    this.userId = opts.userId;
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    this.serverVersion = opts.serverVersion ?? "0.0.0";
  }

  /**
   * Begin serving: read newline-delimited JSON-RPC from `input`, write
   * responses to `output`. Resolves when the input stream ends.
   */
  start(): Promise<void> {
    if (this.done) return this.done;

    this.rl = createInterface({ input: this.input, crlfDelay: Infinity });
    this.logger.info(`${TAG} MCP server started (session_key=${this.sessionKey})`);

    // Serialize response writes: each line is fully handled (possibly async
    // tool work) before the next response is written, preserving order.
    let writeChain: Promise<void> = Promise.resolve();

    this.done = new Promise<void>((resolve) => {
      this.rl!.on("line", (line: string) => {
        writeChain = writeChain.then(async () => {
          // Absorb failures inside the link: a rejected link would poison the
          // chain — every later write would chain onto a rejected promise and
          // never run, killing the transport for good.
          try {
            const response = await this.handleMessage(line);
            if (response !== undefined) {
              this.output.write(response + "\n");
            }
          } catch (err) {
            this.logger.error(
              `${TAG} response write failed (line dropped): ` +
              `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
      });
      this.rl!.on("close", () => {
        // Flush in-flight work before declaring the server done.
        void writeChain.then(() => {
          this.logger.info(`${TAG} Input stream closed — MCP server stopping`);
          resolve();
        });
      });
    });

    return this.done;
  }

  /** Stop reading and release the memory client. Idempotent. */
  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = undefined;
    await super.stop(); // closes this.client
  }

  // ============================
  // Message handling (public for tests)
  // ============================

  /**
   * Process one raw wire line. Returns the serialized response line, or
   * `undefined` when no response must be sent (notifications).
   */
  async handleMessage(raw: string): Promise<string | undefined> {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    const parsed = parseLine(trimmed);

    if (parsed.kind === "invalid") {
      return serialize(parsed.response);
    }

    if (parsed.kind === "notification") {
      // `notifications/initialized`, `notifications/cancelled`, … — per
      // JSON-RPC a notification never receives a response of any kind.
      this.logger.debug?.(`${TAG} notification: ${parsed.notification.method}`);
      return undefined;
    }

    const request = parsed.request;
    try {
      switch (request.method) {
        case "initialize":
          return serialize(successResponse(request.id, this.handleInitialize(request)));
        case "ping":
          return serialize(successResponse(request.id, {}));
        case "tools/list":
          // Pagination cursor ignored — the full list always fits one page.
          return serialize(successResponse(request.id, { tools: TOOL_DEFINITIONS }));
        case "tools/call":
          return serialize(await this.handleToolsCall(request));
        default:
          return serialize(
            errorResponse(request.id, METHOD_NOT_FOUND, `Method not found: ${request.method}`),
          );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`${TAG} Internal error handling ${request.method}: ${msg}`);
      return serialize(errorResponse(request.id, INTERNAL_ERROR, `Internal error: ${msg}`));
    }
  }

  // ============================
  // Request handlers
  // ============================

  private handleInitialize(request: JsonRpcRequest): unknown {
    const requested = request.params?.protocolVersion;
    // Version negotiation per spec: echo the client's version when we support
    // it; otherwise answer with the latest version we do support.
    const protocolVersion =
      typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;

    this.logger.debug?.(
      `${TAG} initialize: client requested ${String(requested)} → negotiating ${protocolVersion}`,
    );

    return {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: this.serverVersion,
      },
    };
  }

  private async handleToolsCall(request: JsonRpcRequest) {
    const name = request.params?.name;
    if (typeof name !== "string" || !name) {
      return errorResponse(request.id, INVALID_PARAMS, "Invalid params: missing tool name");
    }
    const rawArgs = request.params?.arguments;
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};

    try {
      const text = await dispatchToolCall(name, args, {
        client: this.client,
        defaultSessionKey: this.sessionKey,
        userId: this.userId,
      });
      return successResponse(request.id, {
        content: [{ type: "text", text }],
      });
    } catch (err) {
      if (err instanceof UnknownToolError) {
        // Protocol-level error per MCP spec: unknown tool → -32602.
        return errorResponse(request.id, INVALID_PARAMS, err.message);
      }
      // Tool-level failure: report inside the result with isError so the
      // model can see and react to it (NOT a JSON-RPC error, per spec).
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${TAG} tool ${name} failed: ${msg}`);
      return successResponse(request.id, {
        content: [{ type: "text", text: `Tool ${name} failed: ${msg}` }],
        isError: true,
      });
    }
  }
}
