/**
 * OpenClawLLMRunner — wraps the existing CleanContextRunner as a host-neutral LLMRunner.
 *
 * This is a compatibility bridge: TDAI Core modules (L1 extractor, L2 scene extractor,
 * L3 persona generator, L1 dedup) can depend on the `LLMRunner` interface, while
 * OpenClaw continues to use its native embedded agent runner (runEmbeddedAgent) under the hood.
 *
 * Usage:
 *   const factory = new OpenClawLLMRunnerFactory({ config, agentRuntime, logger });
 *   const runner = factory.createRunner({ modelRef: "openai/gpt-4o", enableTools: true });
 *   const result = await runner.run({ prompt: "...", taskId: "l1-extraction" });
 */

import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import type { EmbeddedAgentRuntimeLike } from "../../utils/clean-context-runner.js";
import type {
  LLMRunner,
  LLMRunParams,
  LLMRunnerFactory,
  LLMRunnerCreateOptions,
  Logger,
} from "../../core/types.js";

const TAG = "[memory-tdai] [openclaw-runner]";

// ============================
// OpenClawLLMRunner
// ============================

/**
 * LLMRunner implementation backed by CleanContextRunner.
 *
 * Each instance is configured with a fixed model + tools setting.
 * Create via `OpenClawLLMRunnerFactory.createRunner()`.
 */
export class OpenClawLLMRunner implements LLMRunner {
  private runner: CleanContextRunner;

  constructor(runner: CleanContextRunner) {
    this.runner = runner;
  }

  async run(params: LLMRunParams): Promise<string> {
    return this.runner.run({
      prompt: params.prompt,
      systemPrompt: params.systemPrompt,
      taskId: params.taskId,
      timeoutMs: params.timeoutMs,
      maxTokens: params.maxTokens,
      workspaceDir: params.workspaceDir,
      instanceId: params.instanceId,
    });
  }
}

// ============================
// OpenClawLLMRunnerFactory
// ============================

export interface OpenClawLLMRunnerFactoryOptions {
  /** OpenClaw config object (passed to CleanContextRunner). */
  config: unknown;
  /** Preferred embedded agent runtime (host-injected). */
  agentRuntime?: EmbeddedAgentRuntimeLike;
  /** Logger for runner tracing. */
  logger?: Logger;
  /**
   * OpenClaw host version string (e.g. "2026.8.2") from `api.runtime.version`.
   * Passed through to CleanContextRunner for version-gated behavior
   * (sessionKey vs sessionFile). When undefined, falls back to package.json.
   */
  hostVersion?: string;
}

/**
 * Factory that creates OpenClawLLMRunner instances.
 *
 * Encapsulates the OpenClaw-specific dependencies (config, agentRuntime)
 * so that callers only need to specify model + tools.
 */
export class OpenClawLLMRunnerFactory implements LLMRunnerFactory {
  private config: unknown;
  private agentRuntime?: EmbeddedAgentRuntimeLike;
  private logger?: Logger;
  private hostVersion?: string;

  constructor(opts: OpenClawLLMRunnerFactoryOptions) {
    this.config = opts.config;
    this.agentRuntime = opts.agentRuntime;
    this.logger = opts.logger;
    this.hostVersion = opts.hostVersion;
  }

  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner {
    const enableTools = opts?.enableTools ?? false;
    const modelRef = opts?.modelRef;

    this.logger?.debug?.(
      `${TAG} Creating OpenClawLLMRunner: model=${modelRef ?? "(default)"}, tools=${enableTools}`,
    );

    const cleanRunner = new CleanContextRunner({
      config: this.config,
      modelRef,
      enableTools,
      agentRuntime: this.agentRuntime,
      logger: this.logger,
      hostVersion: this.hostVersion,
    });

    return new OpenClawLLMRunner(cleanRunner);
  }
}
