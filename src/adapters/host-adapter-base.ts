/**
 * HostAdapterBase — shared HostAdapter implementation for every platform.
 *
 * All adapters, MCP and HTTP alike, need the same four things: a data
 * directory, a logger, an LLM runner factory, and a RuntimeContext. Those live
 * here. Transport-specific behaviour is a thin subclass:
 *
 *   McpHostAdapterBase  — adds default-session-key resolution (stdio is
 *                         one session per process, so the key comes from an
 *                         env var at startup)
 *   HTTP adapters       — extend this class directly; they need nothing extra
 *
 * Subclasses provide `hostType` and `platformId`.
 *
 * A note on RuntimeContext: TdaiCore currently reads only `dataDir` from it.
 * `userId`, `sessionKey` and `platform` are populated for completeness but are
 * not yet used to scope storage — per-user isolation is not implemented. Do
 * not rely on them for tenancy.
 */

import { StandaloneLLMRunnerFactory } from "./standalone/llm-runner.js";
import type { StandaloneLLMConfig } from "./standalone/llm-runner.js";
import type {
  HostAdapter,
  RuntimeContext,
  Logger,
  LLMRunnerFactory,
} from "../core/types.js";
import { makeStderrLogger } from "./utils.js";

// ============================
// Shared options
// ============================

export interface HostAdapterBaseOptions {
  /** Base data directory for TDAI storage. */
  dataDir: string;
  /** LLM configuration for memory extraction / persona pipelines. */
  llmConfig: StandaloneLLMConfig;
  /** Logger (defaults to stderr-based console logger). */
  logger?: Logger;
  /** Default user identifier (defaults to "default_user"). */
  userId?: string;
}

export type { StandaloneLLMConfig };

// ============================
// HostAdapterBase
// ============================

export abstract class HostAdapterBase implements HostAdapter {
  /** Platform identifier passed to TdaiCore. */
  abstract readonly hostType: HostAdapter["hostType"];
  /** Platform label written into RuntimeContext. */
  protected abstract readonly platformId: string;

  protected readonly dataDir: string;
  protected readonly userId: string;
  private readonly _logger: Logger;
  private readonly runnerFactory: StandaloneLLMRunnerFactory;

  constructor(opts: HostAdapterBaseOptions) {
    this.dataDir = opts.dataDir;
    this.userId = opts.userId ?? "default_user";
    this._logger = opts.logger ?? makeStderrLogger();

    this.runnerFactory = new StandaloneLLMRunnerFactory({
      config: opts.llmConfig,
      logger: this._logger,
    });
  }

  /**
   * Session key for the process-level context.
   * Base default is the platform id; MCP adapters override with a resolved
   * per-process key. Deliberately not called from the constructor so that
   * subclass field initializers have already run by the time it is used.
   */
  protected contextSessionKey(): string {
    return this.platformId;
  }

  getRuntimeContext(): RuntimeContext {
    const sessionKey = this.contextSessionKey();
    return {
      userId: this.userId,
      sessionId: sessionKey,
      sessionKey,
      platform: this.platformId,
      workspaceDir: this.dataDir,
      dataDir: this.dataDir,
    };
  }

  getLogger(): Logger {
    return this._logger;
  }

  getLLMRunnerFactory(): LLMRunnerFactory {
    return this.runnerFactory;
  }
}
