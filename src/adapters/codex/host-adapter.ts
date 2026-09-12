/**
 * CodexHostAdapter — HostAdapter for the Codex MCP integration.
 *
 * Codex starts the MCP server as a local stdio process. The adapter keeps the
 * memory engine in that process and uses the standalone OpenAI-compatible LLM
 * runner for optional L1/L2/L3 extraction.
 */

import { StandaloneLLMRunnerFactory } from "../standalone/llm-runner.js";
import type { StandaloneLLMConfig } from "../standalone/llm-runner.js";
import type {
  HostAdapter,
  RuntimeContext,
  Logger,
  LLMRunnerFactory,
} from "../../core/types.js";

export interface CodexHostAdapterOptions {
  /** Base directory for TDAI memory data. */
  dataDir: string;
  /** Workspace represented by this MCP process. */
  workspaceDir: string;
  /** OpenAI-compatible LLM configuration for memory extraction. */
  llmConfig: StandaloneLLMConfig;
  /** Logger that must write to stderr so MCP stdout stays protocol-only. */
  logger: Logger;
  /** Stable user ID for this Codex installation. */
  userId?: string;
  /** Default session key used when a tool call omits one. */
  sessionKey: string;
}

export class CodexHostAdapter implements HostAdapter {
  readonly hostType = "codex" as const;

  private readonly context: RuntimeContext;
  private readonly logger: Logger;
  private readonly runnerFactory: StandaloneLLMRunnerFactory;

  constructor(opts: CodexHostAdapterOptions) {
    this.context = {
      userId: opts.userId ?? "codex_user",
      sessionId: opts.sessionKey,
      sessionKey: opts.sessionKey,
      platform: "codex",
      agentContext: "primary",
      workspaceDir: opts.workspaceDir,
      dataDir: opts.dataDir,
    };
    this.logger = opts.logger;
    this.runnerFactory = new StandaloneLLMRunnerFactory({
      config: opts.llmConfig,
      logger: opts.logger,
    });
  }

  getRuntimeContext(): RuntimeContext {
    return this.context;
  }

  getLogger(): Logger {
    return this.logger;
  }

  getLLMRunnerFactory(): LLMRunnerFactory {
    return this.runnerFactory;
  }
}
