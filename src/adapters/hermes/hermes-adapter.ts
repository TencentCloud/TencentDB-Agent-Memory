/**
 * HermesAdapter — TDAI adapter for Hermes Agent platform.
 *
 * This adapter enables TDAI memory capabilities for the Hermes Agent system
 * via HTTP Gateway communication with the core engine.
 *
 * Features:
 * - Full TDAI memory capabilities (L0-L3 pipeline)
 * - Tool registration for memory search
 * - Lifecycle management
 * - Health checks
 *
 * @example
 * ```typescript
 * import { HermesAdapter } from "./hermes-adapter.js";
 *
 * const adapter = new HermesAdapter({
 *   dataDir: "~/.hermes/memory-tdai",
 *   gatewayUrl: "http://localhost:8080",
 * });
 *
 * await adapter.initialize(logger, config);
 * ```
 */

import { BasePlatformAdapter } from "../sdk/base-adapter.js";
import type {
  AdapterConfig,
  PlatformCapabilities,
  MemorySearchResult,
  ConversationSearchResult,
} from "../sdk/platform-adapter.interface.js";
import type { RuntimeContext, Logger, LLMRunnerFactory, RecallResult, CaptureResult, CompletedTurn, MemorySearchParams, ConversationSearchParams } from "../../core/types.js";
import { StandaloneLLMRunnerFactory } from "../standalone/llm-runner.js";

// ============================
// Options
// ============================

export interface HermesAdapterOptions {
  /** Data directory for memory storage */
  dataDir: string;
  /** Gateway HTTP URL */
  gatewayUrl: string;
  /** LLM configuration for model calls */
  llmConfig?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  /** Default configuration */
  defaultConfig?: AdapterConfig;
}

// ============================
// HermesAdapter
// ============================

export class HermesAdapter extends BasePlatformAdapter {
  readonly platformId = "hermes";
  readonly platformName = "Hermes Agent";
  readonly minVersion = "1.0.0";

  readonly capabilities: PlatformCapabilities = {
    supportsRecall: true,
    supportsCapture: true,
    supportsTools: true,
    supportsHttpGateway: true,
    supportsCli: false,
    supportsDataDir: true,
    supportsGracefulShutdown: true,
  };

  // ─────────────────────────────
  // Private state
  // ─────────────────────────────

  private dataDir: string;
  private gatewayUrl: string;
  private llmConfig: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };

  constructor(opts: HermesAdapterOptions) {
    super({
      platformId: "hermes",
      platformName: "Hermes Agent",
      minVersion: "1.0.0",
      capabilities: {
        supportsRecall: true,
        supportsCapture: true,
        supportsTools: true,
        supportsHttpGateway: true,
        supportsDataDir: true,
        supportsGracefulShutdown: true,
      },
      defaultConfig: opts.defaultConfig,
    });

    this.dataDir = opts.dataDir;
    this.gatewayUrl = opts.gatewayUrl;
    this.llmConfig = opts.llmConfig ?? {};
  }

  // ============================
  // BasePlatformAdapter overrides
  // ============================

  protected createLLMRunnerFactory(): LLMRunnerFactory {
    return new StandaloneLLMRunnerFactory({
      config: {
        baseUrl: this.llmConfig.baseUrl ?? "https://api.openai.com/v1",
        apiKey: this.llmConfig.apiKey ?? "",
        model: this.llmConfig.model ?? "gpt-4o",
      },
      logger: this.logger,
    });
  }

  protected createRuntimeContext(): RuntimeContext {
    return {
      userId: "default_user",
      sessionId: "",
      sessionKey: "",
      platform: "hermes",
      workspaceDir: this.dataDir,
      dataDir: this.dataDir,
    };
  }

  protected getConfigSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        dataDir: { type: "string" },
        excludeAgents: { type: "array", items: { type: "string" } },
        gatewayUrl: { type: "string" },
        llm: {
          type: "object",
          properties: {
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            model: { type: "string" },
          },
        },
      },
    };
  }

  protected async doInitialize(): Promise<void> {
    this.info(`Initializing Hermes adapter with gateway: ${this.gatewayUrl}`);

    // Verify gateway connectivity
    try {
      const response = await fetch(`${this.gatewayUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        this.warn(`Gateway health check returned: ${response.status}`);
      }
    } catch (error) {
      this.warn(`Gateway not reachable: ${error}, will retry on first use`);
    }

    this.info("Hermes adapter initialized");
  }

  // ============================
  // Memory capability implementations (via HTTP Gateway)
  // ============================

  async handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult> {
    try {
      const response = await fetch(`${this.gatewayUrl}/memory/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userText, sessionKey }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`Gateway error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      this.error(`Recall failed: ${error}`);
      return {};
    }
  }

  async handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult> {
    try {
      const response = await fetch(`${this.gatewayUrl}/memory/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(turn),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`Gateway error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      this.error(`Capture failed: ${error}`);
      return { l0RecordedCount: 0, schedulerNotified: false, l0VectorsWritten: 0, filteredMessages: [] };
    }
  }

  async searchMemories(params: MemorySearchParams): Promise<MemorySearchResult> {
    try {
      const response = await fetch(`${this.gatewayUrl}/memory/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`Gateway error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      this.error(`Memory search failed: ${error}`);
      return { text: "Memory search unavailable", total: 0, strategy: "none" };
    }
  }

  async searchConversations(params: ConversationSearchParams): Promise<ConversationSearchResult> {
    try {
      const response = await fetch(`${this.gatewayUrl}/memory/conversation/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`Gateway error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      this.error(`Conversation search failed: ${error}`);
      return { text: "Conversation search unavailable", total: 0 };
    }
  }

  // ============================
  // Hermes-specific implementations
  // ============================

  async checkEnvironment(): Promise<{
    passed: boolean;
    issues: Array<{ code: string; message: string; severity: "error" | "warn" }>;
  }> {
    const issues: Array<{ code: string; message: string; severity: "error" | "warn" }> = [];

    // Check Node.js version
    const nodeVersion = process.version;
    const minNodeVersion = "20.0.0";
    if (this.compareVersions(nodeVersion, minNodeVersion) < 0) {
      issues.push({
        code: "NODE_VERSION",
        message: `Node.js ${minNodeVersion}+ required, found ${nodeVersion}`,
        severity: "error",
      });
    }

    // Check gateway connectivity
    try {
      const response = await fetch(`${this.gatewayUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        issues.push({
          code: "GATEWAY_HEALTH",
          message: `Gateway health check failed: ${response.status}`,
          severity: "warn",
        });
      }
    } catch (error) {
      issues.push({
        code: "GATEWAY_CONNECTIVITY",
        message: `Gateway not reachable: ${error}`,
        severity: "error",
      });
    }

    return {
      passed: issues.filter(i => i.severity === "error").length === 0,
      issues,
    };
  }

  async getHealthStatus(): Promise<{
    healthy: boolean;
    details: Record<string, unknown>;
  }> {
    const baseStatus = await super.getHealthStatus();
    let gatewayHealthy = false;

    try {
      const response = await fetch(`${this.gatewayUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      gatewayHealthy = response.ok;
    } catch {
      // Ignore
    }

    return {
      healthy: baseStatus.healthy && gatewayHealthy,
      details: {
        ...baseStatus.details,
        dataDir: this.dataDir,
        gatewayUrl: this.gatewayUrl,
        gatewayHealthy,
      },
    };
  }
}
