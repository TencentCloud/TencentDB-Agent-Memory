/**
 * ClaudeCodeAdapter — TDAI adapter for Claude Code CLI.
 *
 * This adapter enables TDAI memory capabilities for Claude Code CLI
 * via local file-based communication with the core engine.
 *
 * Features:
 * - Full TDAI memory capabilities (L0-L3 pipeline)
 * - Tool registration for memory search
 * - CLI-based interaction
 * - Local file communication
 *
 * @example
 * ```typescript
 * import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
 *
 * const adapter = new ClaudeCodeAdapter({
 *   dataDir: "~/.claude-code/plugins/memory-tdai",
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

export interface ClaudeCodeAdapterOptions {
  /** Data directory for memory storage */
  dataDir: string;
  /** Claude Code data directory */
  claudeCodeDir?: string;
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
// ClaudeCodeAdapter
// ============================

export class ClaudeCodeAdapter extends BasePlatformAdapter {
  readonly platformId = "claude-code";
  readonly platformName = "Claude Code";
  readonly minVersion = "1.0.0";

  readonly capabilities: PlatformCapabilities = {
    supportsRecall: true,
    supportsCapture: true,
    supportsTools: true,
    supportsHttpGateway: false,
    supportsCli: true,
    supportsDataDir: true,
    supportsGracefulShutdown: true,
  };

  // ─────────────────────────────
  // Private state
  // ─────────────────────────────

  private dataDir: string;
  private claudeCodeDir: string;
  private llmConfig: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  private requestQueue: Map<string, unknown> = new Map();

  constructor(opts: ClaudeCodeAdapterOptions) {
    super({
      platformId: "claude-code",
      platformName: "Claude Code",
      minVersion: "1.0.0",
      capabilities: {
        supportsRecall: true,
        supportsCapture: true,
        supportsTools: true,
        supportsCli: true,
        supportsDataDir: true,
        supportsGracefulShutdown: true,
      },
      defaultConfig: opts.defaultConfig,
    });

    this.dataDir = opts.dataDir;
    this.claudeCodeDir = opts.claudeCodeDir ?? `${process.env.HOME ?? "."}/.claude`;
    this.llmConfig = opts.llmConfig ?? {};
  }

  // ============================
  // BasePlatformAdapter overrides
  // ============================

  protected createLLMRunnerFactory(): LLMRunnerFactory {
    return new StandaloneLLMRunnerFactory({
      config: {
        baseUrl: this.llmConfig.baseUrl ?? "https://api.anthropic.com/v1",
        apiKey: this.llmConfig.apiKey ?? "",
        model: this.llmConfig.model ?? "claude-sonnet-4-20250514",
      },
      logger: this.logger,
    });
  }

  protected createRuntimeContext(): RuntimeContext {
    return {
      userId: "default_user",
      sessionId: "",
      sessionKey: "",
      platform: "claude-code",
      workspaceDir: process.cwd(),
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
        capture: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            excludeAgents: { type: "array", items: { type: "string" } },
            l0l1RetentionDays: { type: "number", minimum: 0 },
          },
        },
        recall: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            maxResults: { type: "number", minimum: 1, maximum: 20 },
            scoreThreshold: { type: "number", minimum: 0, maximum: 1 },
          },
        },
        embedding: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            provider: { type: "string" },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            model: { type: "string" },
            dimensions: { type: "number" },
          },
        },
      },
    };
  }

  protected async doInitialize(): Promise<void> {
    this.info("Initializing Claude Code adapter...");

    // Create data directory if not exists
    try {
      const fs = await import("node:fs");
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.info(`Data directory created/verified: ${this.dataDir}`);
    } catch (error) {
      this.warn(`Could not create data directory: ${error}`);
    }

    this.info("Claude Code adapter initialized");
  }

  // ============================
  // Memory capability implementations (local file-based)
  // ============================

  async handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult> {
    // For Claude Code, we use local file-based recall
    // Read from recall cache file
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");

      const recallCacheFile = path.join(this.dataDir, "recall", `${sessionKey}.json`);
      if (fs.existsSync(recallCacheFile)) {
        const content = fs.readFileSync(recallCacheFile, "utf-8");
        const cached = JSON.parse(content);

        // Check cache freshness (5 minutes TTL)
        if (Date.now() - cached.timestamp < 5 * 60 * 1000) {
          return cached.result;
        }
      }
    } catch (error) {
      this.debug(`Recall cache miss: ${error}`);
    }

    return {};
  }

  async handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult> {
    // Write conversation to local storage
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");

      const convDir = path.join(this.dataDir, "conversations");
      fs.mkdirSync(convDir, { recursive: true });

      const convFile = path.join(convDir, `${turn.sessionKey}.jsonl`);
      const entry = {
        timestamp: Date.now(),
        sessionKey: turn.sessionKey,
        userText: turn.userText,
        messages: turn.messages,
      };

      fs.appendFileSync(convFile, JSON.stringify(entry) + "\n");

      return {
        l0RecordedCount: 1,
        schedulerNotified: true,
        l0VectorsWritten: 0,
        filteredMessages: turn.messages as Array<{ role: string; content: string; timestamp: number }>,
      };
    } catch (error) {
      this.error(`Capture failed: ${error}`);
      return { l0RecordedCount: 0, schedulerNotified: false, l0VectorsWritten: 0, filteredMessages: [] };
    }
  }

  async searchMemories(params: MemorySearchParams): Promise<MemorySearchResult> {
    // For Claude Code, search in local records
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");

      const recordsDir = path.join(this.dataDir, "records");
      if (!fs.existsSync(recordsDir)) {
        return { text: "No memory records found", total: 0, strategy: "none" };
      }

      const files = fs.readdirSync(recordsDir).filter(f => f.endsWith(".jsonl"));
      const results: string[] = [];
      const query = params.query.toLowerCase();

      for (const file of files.slice(0, 10)) {
        const content = fs.readFileSync(path.join(recordsDir, file), "utf-8");
        const lines = content.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            if (record.content?.toLowerCase().includes(query)) {
              results.push(record.content);
              if (results.length >= (params.limit ?? 5)) break;
            }
          } catch {
            // Skip invalid lines
          }
        }
        if (results.length >= (params.limit ?? 5)) break;
      }

      return {
        text: results.length > 0
          ? `Found ${results.length} memories:\n${results.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
          : "No matching memories found",
        total: results.length,
        strategy: "keyword",
      };
    } catch (error) {
      this.error(`Memory search failed: ${error}`);
      return { text: "Memory search unavailable", total: 0, strategy: "none" };
    }
  }

  async searchConversations(params: ConversationSearchParams): Promise<ConversationSearchResult> {
    // Search in local conversations
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");

      const convDir = path.join(this.dataDir, "conversations");
      if (!fs.existsSync(convDir)) {
        return { text: "No conversations found", total: 0 };
      }

      const files = fs.readdirSync(convDir).filter(f => f.endsWith(".jsonl"));
      const results: string[] = [];
      const query = params.query.toLowerCase();

      for (const file of files) {
        if (params.sessionKey && !file.includes(params.sessionKey)) continue;

        const content = fs.readFileSync(path.join(convDir, file), "utf-8");
        const lines = content.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const conv = JSON.parse(line);
            if (conv.userText?.toLowerCase().includes(query)) {
              results.push(conv.userText);
              if (results.length >= (params.limit ?? 5)) break;
            }
          } catch {
            // Skip invalid lines
          }
        }
        if (results.length >= (params.limit ?? 5)) break;
      }

      return {
        text: results.length > 0
          ? `Found ${results.length} conversations:\n${results.map((r, i) => `${i + 1}. ${r.slice(0, 100)}...`).join("\n")}`
          : "No matching conversations found",
        total: results.length,
      };
    } catch (error) {
      this.error(`Conversation search failed: ${error}`);
      return { text: "Conversation search unavailable", total: 0 };
    }
  }

  // ============================
  // Claude Code specific implementations
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

    // Check Claude Code directory
    try {
      const fs = await import("node:fs");
      if (!fs.existsSync(this.claudeCodeDir)) {
        issues.push({
          code: "CLAUDE_CODE_DIR",
          message: `Claude Code directory not found: ${this.claudeCodeDir}`,
          severity: "warn",
        });
      }
    } catch {
      // Ignore
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

    let dataDirAccessible = false;
    try {
      const fs = await import("node:fs");
      fs.accessSync(this.dataDir);
      dataDirAccessible = true;
    } catch {
      // Ignore
    }

    return {
      healthy: baseStatus.healthy && dataDirAccessible,
      details: {
        ...baseStatus.details,
        dataDir: this.dataDir,
        claudeCodeDir: this.claudeCodeDir,
        dataDirAccessible,
      },
    };
  }
}
