import { StandaloneLLMRunnerFactory } from "../standalone/llm-runner.js";
import type { StandaloneLLMConfig } from "../standalone/llm-runner.js";
import type { HostAdapter, RuntimeContext, Logger, LLMRunnerFactory } from "../../core/types.js";

export interface CodeBuddyHostAdapterOptions {
  dataDir: string; logger: Logger; llmConfig?: StandaloneLLMConfig;
  defaultUserId?: string; platform?: string;
}

export class CodeBuddyHostAdapter implements HostAdapter {
  readonly hostType = "standalone" as const;
  private dataDir: string; private logger: Logger;
  private runnerFactory: StandaloneLLMRunnerFactory;
  private defaultUserId: string; private platform: string;

  constructor(opts: CodeBuddyHostAdapterOptions) {
    this.dataDir = opts.dataDir; this.logger = opts.logger;
    this.defaultUserId = opts.defaultUserId ?? "default_user";
    this.platform = opts.platform ?? "codebuddy";
    this.runnerFactory = new StandaloneLLMRunnerFactory({
      config: opts.llmConfig ?? {} as StandaloneLLMConfig, logger: opts.logger,
    });
  }

  getRuntimeContext(): RuntimeContext {
    return { userId: this.defaultUserId, sessionId: "", sessionKey: "",
      platform: this.platform, workspaceDir: process.cwd(), dataDir: this.dataDir };
  }

  buildRuntimeContextForSession(sessionKey: string, sessionId?: string): RuntimeContext {
    return { userId: this.defaultUserId, sessionId: sessionId ?? "", sessionKey,
      platform: this.platform, workspaceDir: process.cwd(), dataDir: this.dataDir };
  }

  getLogger(): Logger { return this.logger; }
  getLLMRunnerFactory(): LLMRunnerFactory { return this.runnerFactory; }
  getDataDir(): string { return this.dataDir; }
}
