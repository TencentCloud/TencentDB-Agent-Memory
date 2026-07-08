/**
 * McpHostAdapter — HostAdapter for the MCP (Model Context Protocol) server.
 *
 * Pattern C in the adapter family: in-process TdaiCore wrapped as an MCP
 * server. No OpenClaw dependency, no HTTP hop. The MCP server process IS
 * the host that owns TdaiCore.
 *
 * Reuses `hostType: "standalone"` on purpose — Core's wirePipelineRunners
 * branches on `hostType !== "openclaw"` to pick the standalone LLM runner,
 * and that is exactly what we want. Adding a new literal would force a
 * dead-code branch update inside Core for zero benefit.
 *
 * The MCP transport is stdio JSON-RPC, so stdout is reserved for protocol
 * bytes. Every log line from this adapter (and from Core, via the logger
 * returned here) MUST go to stderr. Console is redirected accordingly.
 */

import { StandaloneLLMRunnerFactory } from "../standalone/llm-runner.js";
import type { StandaloneLLMConfig } from "../standalone/llm-runner.js";
import type {
  HostAdapter,
  RuntimeContext,
  Logger,
  LLMRunnerFactory,
} from "../../core/types.js";

// ============================
// Options
// ============================

export interface McpHostAdapterOptions {
  /** Base data directory for TDAI storage (L0/L1/L2/L3 + vectors.db). */
  dataDir: string;
  /** LLM configuration for memory extraction (OpenAI-compatible HTTP). */
  llmConfig: StandaloneLLMConfig;
  /** Logger instance — must already write to stderr (NOT stdout). */
  logger: Logger;
  /** Default user ID (env-driven, default "default_user"). */
  defaultUserId?: string;
}

// ============================
// McpHostAdapter
// ============================

export class McpHostAdapter implements HostAdapter {
  readonly hostType = "standalone" as const;

  private dataDir: string;
  private logger: Logger;
  private runnerFactory: StandaloneLLMRunnerFactory;
  private defaultUserId: string;

  constructor(opts: McpHostAdapterOptions) {
    this.dataDir = opts.dataDir;
    this.logger = opts.logger;
    this.defaultUserId = opts.defaultUserId ?? "default_user";

    this.runnerFactory = new StandaloneLLMRunnerFactory({
      config: opts.llmConfig,
      logger: this.logger,
    });
  }

  getRuntimeContext(): RuntimeContext {
    return {
      userId: this.defaultUserId,
      sessionId: "",
      sessionKey: "",
      platform: "mcp",
      workspaceDir: this.dataDir,
      dataDir: this.dataDir,
    };
  }

  /**
   * Build a RuntimeContext scoped to a specific MCP client request.
   *
   * MCP requests carry session identifiers via the `_meta` field or via
   * tool arguments (session_key). The MCP server uses this helper to
   * stamp each request with the correct identity.
   */
  buildRuntimeContextForRequest(params: {
    userId?: string;
    sessionId?: string;
    sessionKey?: string;
  }): RuntimeContext {
    return {
      userId: params.userId ?? this.defaultUserId,
      sessionId: params.sessionId ?? "",
      sessionKey: params.sessionKey ?? params.sessionId ?? "",
      platform: "mcp",
      workspaceDir: this.dataDir,
      dataDir: this.dataDir,
    };
  }

  getLogger(): Logger {
    return this.logger;
  }

  getLLMRunnerFactory(): LLMRunnerFactory {
    return this.runnerFactory;
  }
}

// ============================
// Stderr-only logger
// ============================

/**
 * Build a Logger that writes exclusively to stderr.
 *
 * Critical for MCP: stdout is the JSON-RPC transport. Any byte on stdout
 * that is not a valid JSON-RPC message corrupts the protocol stream and
 * breaks the client. We redirect info/warn/error to console.error (which
 * writes to stderr) and debug to stderr only when TDAI_MCP_DEBUG=1.
 */
export function createStderrLogger(debugEnabled = false): Logger {
  const tag = "[memory-tdai] [mcp]";
  return {
    debug: debugEnabled
      ? (msg: string) => process.stderr.write(`${tag} DEBUG ${msg}\n`)
      : undefined,
    info: (msg: string) => process.stderr.write(`${tag} INFO ${msg}\n`),
    warn: (msg: string) => process.stderr.write(`${tag} WARN ${msg}\n`),
    error: (msg: string) => process.stderr.write(`${tag} ERROR ${msg}\n`),
  };
}
