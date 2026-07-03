/**
 * CodeBuddyHostAdapter — 腾讯 CodeBuddy IDE 平台适配器.
 *
 * CodeBuddy 是腾讯自研的 AI 编程助手（IDE 插件）。
 * 本适配器遵循与 OpenClawHostAdapter 相同的"薄壳"模式，
 * 将 CodeBuddy 的运行上下文翻译为 TdaiCore 的 HostAdapter 接口。
 *
 * CodeBuddy 集成方式（预期）:
 *   1. CodeBuddy MCP 支持 — 注册 tdai_* 工具
 *   2. CodeBuddy plugin/hook 系统 — 自动 recall + capture
 *   3. 本适配器提供统一上下文管理
 *
 * 与 Claude Code 适配器共享 StandaloneLLMRunnerFactory 模式。
 *
 * Usage:
 *   const adapter = new CodeBuddyHostAdapter({ dataDir, logger, platform: "codebuddy" });
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

// ============================
// Options
// ============================

export interface CodeBuddyHostAdapterOptions {
  /** 数据目录 */
  dataDir: string;
  /** 日志器 */
  logger: Logger;
  /** LLM 配置（可选） */
  llmConfig?: StandaloneLLMConfig;
  /** 默认用户 ID */
  defaultUserId?: string;
  /** 平台标识 */
  platform?: string;
}

// ============================
// CodeBuddyHostAdapter
// ============================

export class CodeBuddyHostAdapter implements HostAdapter {
  readonly hostType = "standalone" as const;

  private dataDir: string;
  private logger: Logger;
  private runnerFactory: StandaloneLLMRunnerFactory;
  private defaultUserId: string;
  private platform: string;

  constructor(opts: CodeBuddyHostAdapterOptions) {
    this.dataDir = opts.dataDir;
    this.logger = opts.logger;
    this.defaultUserId = opts.defaultUserId ?? "default_user";
    this.platform = opts.platform ?? "codebuddy";

    this.runnerFactory = new StandaloneLLMRunnerFactory({
      config: opts.llmConfig ?? {} as StandaloneLLMConfig,
      logger: opts.logger,
    });
  }

  getRuntimeContext(): RuntimeContext {
    return {
      userId: this.defaultUserId,
      sessionId: "",
      sessionKey: "",
      platform: this.platform,
      workspaceDir: process.cwd(),
      dataDir: this.dataDir,
    };
  }

  buildRuntimeContextForSession(sessionKey: string, sessionId?: string): RuntimeContext {
    return {
      userId: this.defaultUserId,
      sessionId: sessionId ?? "",
      sessionKey,
      platform: this.platform,
      workspaceDir: process.cwd(),
      dataDir: this.dataDir,
    };
  }

  getLogger(): Logger {
    return this.logger;
  }

  getLLMRunnerFactory(): LLMRunnerFactory {
    return this.runnerFactory;
  }

  getDataDir(): string {
    return this.dataDir;
  }
}
