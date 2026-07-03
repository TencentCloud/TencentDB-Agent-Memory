/**
 * CCHostAdapter — Claude Code 平台适配器.
 *
 * 将 Claude Code 运行时上下文翻译为 TdaiCore 的 HostAdapter 接口。
 * 遵循与 OpenClawHostAdapter (117行) / StandaloneHostAdapter (97行) 相同的"薄壳"模式。
 *
 * Usage:
 *   const adapter = new CCHostAdapter({ dataDir, logger, platform: "claude-code" });
 *   const core = new TdaiCore({ hostAdapter: adapter, config });
 */

import { StandaloneLLMRunnerFactory } from "../standalone/llm-runner.js";
import type { StandaloneLLMConfig } from "../standalone/llm-runner.js";
import type {
  HostAdapter,
  RuntimeContext,
  Logger,
  LLMRunnerFactory,
} from "../../core/types.js";

export interface CCHostAdapterOptions {
  dataDir: string;
  logger: Logger;
  llmConfig?: StandaloneLLMConfig;
  defaultUserId?: string;
  platform?: string;
}

export class CCHostAdapter implements HostAdapter {
  readonly hostType = "standalone" as const;
  private dataDir: string;
  private logger: Logger;
  private runnerFactory: StandaloneLLMRunnerFactory;
  private defaultUserId: string;
  private platform: string;

  constructor(opts: CCHostAdapterOptions) {
    this.dataDir = opts.dataDir;
    this.logger = opts.logger;
    this.defaultUserId = opts.defaultUserId ?? "default_user";
    this.platform = opts.platform ?? "claude-code";
    this.runnerFactory = new StandaloneLLMRunnerFactory({
      config: opts.llmConfig ?? {} as StandaloneLLMConfig,
      logger: opts.logger,
    });
  }

  getRuntimeContext(): RuntimeContext {
    return { userId: this.defaultUserId, sessionId: "", sessionKey: "", platform: this.platform, workspaceDir: process.cwd(), dataDir: this.dataDir };
  }

  buildRuntimeContextForSession(sessionKey: string, sessionId?: string): RuntimeContext {
    return { userId: this.defaultUserId, sessionId: sessionId ?? "", sessionKey, platform: this.platform, workspaceDir: process.cwd(), dataDir: this.dataDir };
  }

  getLogger(): Logger { return this.logger; }
  getLLMRunnerFactory(): LLMRunnerFactory { return this.runnerFactory; }
  getDataDir(): string { return this.dataDir; }
}
