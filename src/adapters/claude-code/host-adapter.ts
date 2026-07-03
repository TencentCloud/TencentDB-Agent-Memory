/**
 * CCHostAdapter — Claude Code 平台适配器.
 *
 * 将 Claude Code 的运行时上下文翻译为 TdaiCore 的 HostAdapter 接口。
 * 遵循与 OpenClawHostAdapter (117行) / StandaloneHostAdapter (97行) 相同的"薄壳"模式。
 *
 * Claude Code 的集成方式:
 *   1. CC MCP server 注册 tdai_* 工具 → 调用 Gateway HTTP API
 *   2. CC hooks (shell commands) → 调用 Gateway /recall + /capture
 *   3. 本适配器提供统一上下文管理
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

// ============================
// Options
// ============================

export interface CCHostAdapterOptions {
  /** 数据目录 */
  dataDir: string;
  /** 日志器 */
  logger: Logger;
  /** LLM 配置（可选 — CC 自己管理 LLM，Gateway 的 pipeline 可以用） */
  llmConfig?: StandaloneLLMConfig;
  /** 默认用户 ID */
  defaultUserId?: string;
  /** 平台标识 */
  platform?: string;
}

// ============================
// CCHostAdapter
// ============================

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

    // LLM runner factory for pipeline (L1/L2/L3)
    // 如果未配置 LLM，使用空配置 — pipeline 会在运行时优雅降级
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

  /**
   * 为特定 session 构建 RuntimeContext。
   * CC 的 session_id 通常是项目路径 + 会话标识的组合。
   */
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

  /** 获取数据目录 */
  getDataDir(): string {
    return this.dataDir;
  }
}
