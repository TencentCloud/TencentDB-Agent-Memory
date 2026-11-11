/**
 * MemoryPlatformAdapter — 所有跨平台适配器的统一接口。
 *
 * 每个平台适配器都实现此接口，确保所有平台的行为完全一致。
 *
 * 设计原则：
 * 1. 接口是合约 — 所有适配器必须有相同的方法签名和语义
 * 2. 零平台依赖 — 接口不包含任何平台特定的字段
 * 3. Gateway 是真相源 — 所有适配器通过 Gateway HTTP 通信
 *
 * 类型与 Gateway HTTP API（src/gateway/types.ts）对齐。
 */

import type { GatewayClient } from "./shared/gateway-client.js";

// ============================
// 响应类型
// ============================

/** 记忆召回结果。 */
export interface MemoryRecallResult {
  /** 召回的记忆上下文文本。 */
  context: string;
  /** 召回策略名（如 "l1"，"hybrid"）。 */
  strategy?: string;
  /** 召回的记忆条数。 */
  memoryCount?: number;
}

/** 对话捕获结果。 */
export interface MemoryCaptureResult {
  /** L0 记录的条数。 */
  l0Recorded: number;
  /** 调度器是否被唤醒。 */
  schedulerNotified: boolean;
}

/** 记忆搜索结果。 */
export interface MemorySearchResult {
  /** 格式化的搜索结果文本。 */
  results: string;
  /** 结果总数。 */
  total: number;
  /** 搜索策略名。 */
  strategy?: string;
}

/** 健康检查结果。 */
export interface MemoryHealthResult {
  /** 状态：ok 或 degraded。 */
  status: "ok" | "degraded";
  /** Gateway 版本号。 */
  version: string;
  /** Gateway 运行时间（秒）。 */
  uptime: number;
  /** 各存储状态。 */
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
}

// ============================
// 核心接口
// ============================

/**
 * 所有平台适配器必须实现的统一接口。
 *
 * 合约测试（contract test）会针对每个实现运行相同的断言。
 *
 * @example
 * ```ts
 * class MyAdapter implements MemoryPlatformAdapter {
 *   readonly name = "my-app";
 *   readonly platform = "custom";
 *   // ... 实现所有方法
 * }
 * ```
 */
export interface MemoryPlatformAdapter {
  /** 适配器名称（用于日志和标识）。 */
  readonly name: string;

  /** 平台标识符（如 "mcp"、"codex"、"claude-code"、"dify"、"rest"）。 */
  readonly platform: string;

  /** 健康检查。 */
  health(): Promise<MemoryHealthResult>;

  /** 记忆召回（在 LLM 提示词构建前调用）。 */
  recall(query: string, sessionKey: string): Promise<MemoryRecallResult>;

  /** 对话捕获（在 LLM 对话完成后调用）。 */
  capture(
    userContent: string,
    assistantContent: string,
    sessionKey: string,
    sessionId?: string,
  ): Promise<MemoryCaptureResult>;

  /** 搜索 L1 结��化记忆。 */
  searchMemories(
    query: string,
    limit?: number,
    type?: string,
    scene?: string,
  ): Promise<MemorySearchResult>;

  /** 搜索 L0 原始对话。 */
  searchConversations(
    query: string,
    limit?: number,
    sessionKey?: string,
  ): Promise<MemorySearchResult>;

  /** 结束会话并触发缓冲数据刷新。 */
  endSession(sessionKey: string): Promise<void>;
}

// ============================
// 基础抽象类
// ============================

/**
 * 基础适配器类 — 所有平台适配器继承此类。
 *
 * 提供共享的 GatewayClient 委托逻辑。子类只需设置
 * name 和 platform 属性，所有方法自动委托给 client。
 *
 * @example
 * ```ts
 * class RestMemoryAdapter extends BaseMemoryPlatformAdapter {
 *   readonly name = "rest-adapter";
 *   readonly platform = "rest";
 * }
 * ```
 */
export abstract class BaseMemoryPlatformAdapter implements MemoryPlatformAdapter {
  abstract readonly name: string;
  abstract readonly platform: string;

  /** 内部 Gateway 客户端。子类可通过 this.client 访问。 */
  protected readonly client: GatewayClient;

  constructor(client: GatewayClient) {
    this.client = client;
  }

  async health(): Promise<MemoryHealthResult> {
    return this.client.health();
  }

  async recall(query: string, sessionKey: string): Promise<MemoryRecallResult> {
    const result = await this.client.recall(query, sessionKey);
    return {
      context: result.context,
      strategy: result.strategy,
      memoryCount: result.memory_count,
    };
  }

  async capture(
    userContent: string,
    assistantContent: string,
    sessionKey: string,
    sessionId?: string,
  ): Promise<MemoryCaptureResult> {
    const result = await this.client.capture(
      userContent,
      assistantContent,
      sessionKey,
      sessionId,
    );
    return {
      l0Recorded: result.l0_recorded,
      schedulerNotified: result.scheduler_notified,
    };
  }

  async searchMemories(
    query: string,
    limit?: number,
    type?: string,
    scene?: string,
  ): Promise<MemorySearchResult> {
    const result = await this.client.searchMemories(query, limit, type, scene);
    return {
      results: result.results,
      total: result.total,
      strategy: result.strategy,
    };
  }

  async searchConversations(
    query: string,
    limit?: number,
    sessionKey?: string,
  ): Promise<MemorySearchResult> {
    const result = await this.client.searchConversations(query, limit, sessionKey);
    return {
      results: result.results,
      total: result.total,
      strategy: undefined,
    };
  }

  async endSession(sessionKey: string): Promise<void> {
    await this.client.endSession(sessionKey);
  }
}
