/**
 * OpenCode 适配器 — 将 OpenCode 运行时事件映射到 TDAI 记忆操作。
 *
 * OpenCode 是一个基于 VS Code 扩展的 Agent 框架。
 * 此适配器提供：
 * - PrePrompt 阶段的记忆召回（注入到系统提示）
 * - PostCompletion 阶段的对话捕获（写入 L0）
 * - 会话结束时的待处理刷新
 * - 主动搜索工具（通过 tool 暴露给 Agent）
 *
 * 设计参考 PR #490 的 OpenCode 适配器，但集成我们的 retry + circuit-breaker。
 */

import { BaseMemoryPlatformAdapter } from "../memory-platform-adapter.js";
import type {
  MemoryRecallResult,
  MemoryCaptureResult,
  MemorySearchResult,
} from "../memory-platform-adapter.js";
import type { GatewayClient } from "../shared/gateway-client.js";

// ============================
// OpenCode 配置
// ============================

export interface OpenCodeAdapterOptions {
  /** Gateway HTTP 客户端。 */
  client: GatewayClient;
  /** 默认用户 ID。 */
  defaultUserId?: string;
  /** 会话键前缀（用于多 workspace 隔离）。 */
  workspacePrefix?: string;
}

// ============================
// OpenCodeMemoryAdapter
// ============================

/**
 * OpenCode 记忆适配器。
 *
 * @example
 * ```ts
 * import { GatewayClient } from "@tencentdb-agent-memory/memory-tencentdb";
 *
 * const client = new GatewayClient({ baseUrl: "http://127.0.0.1:8420" });
 * const adapter = new OpenCodeMemoryAdapter({
 *   client,
 *   workspacePrefix: "my-project",
 * });
 *
 * // PrePrompt 阶段
 * const recall = await adapter.recallForPrompt("当前任务", "session-1");
 * // 将 recall.context 注入到系统提示中
 *
 * // PostCompletion 阶段
 * await adapter.captureTurn({
 *   userText: "用户输入",
 *   assistantText: "助手输出",
 *   sessionKey: "session-1",
 * });
 * ```
 */
export class OpenCodeMemoryAdapter extends BaseMemoryPlatformAdapter {
  readonly name = "opencode-memory-adapter";
  readonly platform = "opencode" as const;

  private defaultUserId: string;
  private workspacePrefix: string;

  constructor(opts: OpenCodeAdapterOptions) {
    super(opts.client);
    this.defaultUserId = opts.defaultUserId ?? "opencode-user";
    this.workspacePrefix = opts.workspacePrefix ?? "";
  }

  // ============================
  // 生命周期方法
  // ============================

  /**
   * PrePrompt 阶段：召回相关记忆上下文。
   *
   * 在 OpenCode 构建 prompt 前调用。
   * 返回的 context 应注入到系统提示中。
   */
  async recallForPrompt(
    userPrompt: string,
    sessionKey: string,
    userId?: string,
  ): Promise<MemoryRecallResult> {
    try {
      const response = await this.client.recall(
        userPrompt,
        this.resolveSessionKey(sessionKey),
        userId ?? this.defaultUserId,
      );
      return {
        context: response.context,
        strategy: response.strategy,
        memoryCount: response.memory_count,
      };
    } catch (error) {
      // Fail-open：召回失败不阻塞 Agent 执行
      return {
        context: "",
        strategy: "error",
        memoryCount: 0,
      };
    }
  }

  /**
   * PostCompletion 阶段：捕获完成的对话轮次。
   *
   * 在 Agent 完成一轮响应后调用。
   */
  async captureTurn(params: {
    userText: string;
    assistantText: string;
    sessionKey: string;
    sessionId?: string;
    userId?: string;
  }): Promise<MemoryCaptureResult> {
    try {
      const response = await this.client.capture(
        params.userText,
        params.assistantText,
        this.resolveSessionKey(params.sessionKey),
        params.sessionId,
        params.userId ?? this.defaultUserId,
      );
      return {
        l0Recorded: response.l0_recorded,
        schedulerNotified: response.scheduler_notified,
      };
    } catch (error) {
      // Fail-open：捕获失败不影响 Agent 执行
      return {
        l0Recorded: 0,
        schedulerNotified: false,
      };
    }
  }

  /**
   * 搜索 L1 结构化记忆。
   *
   * 可作为 OpenCode tool 暴露给 Agent。
   */
  async searchMemory(
    query: string,
    limit = 5,
    type?: string,
    scene?: string,
  ): Promise<MemorySearchResult> {
    try {
      const response = await this.client.searchMemories(query, limit, type, scene);
      return {
        results: response.results,
        total: response.total,
        strategy: response.strategy,
      };
    } catch (error) {
      return {
        results: "[]",
        total: 0,
        strategy: "error",
      };
    }
  }

  /**
   * 搜索 L0 原始对话。
   */
  async searchConversations(
    query: string,
    limit = 5,
    sessionKey?: string,
  ): Promise<MemorySearchResult> {
    try {
      const response = await this.client.searchConversations(
        query,
        limit,
        sessionKey ? this.resolveSessionKey(sessionKey) : undefined,
      );
      return {
        results: response.results,
        total: response.total,
      };
    } catch (error) {
      return {
        results: "[]",
        total: 0,
      };
    }
  }

  /**
   * 结束会话并刷新待处理工作。
   */
  async endSession(sessionKey: string, userId?: string): Promise<{ flushed: boolean }> {
    try {
      const response = await this.client.endSession(
        this.resolveSessionKey(sessionKey),
        userId ?? this.defaultUserId,
      );
      return { flushed: response.flushed };
    } catch (error) {
      return { flushed: false };
    }
  }

  // ============================
  // 内部
  // ============================

  /**
   * 生成稳定的 session key。
   *
   * 格式：opencode:{workspace}:{session}
   * workspace 前缀确保多项目隔离。
   */
  resolveSessionKey(sessionKey: string): string {
    if (this.workspacePrefix) {
      return `opencode:${this.workspacePrefix}:${sessionKey}`;
    }
    return `opencode:${sessionKey}`;
  }
}
