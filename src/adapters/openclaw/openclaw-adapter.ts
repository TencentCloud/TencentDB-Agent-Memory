/**
 * OpenClawAdapter — Complete TDAI adapter for OpenClaw platform.
 *
 * This adapter implements all SKILL capabilities:
 * - Setup Skill: Install, configure, and validate the plugin
 * - Migration Skill: Migrate from old plugin versions
 * - Diagnostic Skill: Export diagnostic data for troubleshooting
 *
 * Features:
 * - Full TDAI memory capabilities (L0-L3 pipeline)
 * - Tool registration (tdai_memory_search, tdai_conversation_search)
 * - Lifecycle management (install, upgrade, uninstall)
 * - Health checks
 * - Event emission for observability
 *
 * @example
 * ```typescript
 * import { OpenClawAdapter } from "./openclaw-adapter.js";
 *
 * const adapter = new OpenClawAdapter({
 *   pluginDataDir: "~/.openclaw/state/memory-tdai",
 *   openclawConfig: api.config,
 * });
 *
 * await adapter.initialize(logger, config);
 * ```
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { BasePlatformAdapter } from "../sdk/base-adapter.js";
import type {
  AdapterConfig,
  PlatformCapabilities,
  DiagnosticExportOptions,
  MemorySearchResult,
  ConversationSearchResult,
} from "../sdk/platform-adapter.interface.js";
import type { RuntimeContext, Logger, LLMRunnerFactory, RecallResult, CaptureResult, CompletedTurn, MemorySearchParams, ConversationSearchParams } from "../../core/types.js";
import { TdaiCore } from "../../core/tdai-core.js";
import { OpenClawLLMRunnerFactory } from "./llm-runner.js";
import { SessionFilter } from "../../utils/session-filter.js";

// ============================
// OpenClaw config schema
// ============================

interface OpenClawPluginConfig {
  capture?: {
    enabled?: boolean;
    excludeAgents?: string[];
    l0l1RetentionDays?: number;
    cleanTime?: string;
  };
  extraction?: {
    enabled?: boolean;
    enableDedup?: boolean;
    maxMemoriesPerSession?: number;
    model?: string;
  };
  pipeline?: {
    everyNConversations?: number;
    enableWarmup?: boolean;
    l1IdleTimeoutSeconds?: number;
    l2DelayAfterL1Seconds?: number;
    l2MinIntervalSeconds?: number;
    l2MaxIntervalSeconds?: number;
    sessionActiveWindowHours?: number;
  };
  recall?: {
    enabled?: boolean;
    maxResults?: number;
    scoreThreshold?: number;
    strategy?: string;
  };
  persona?: {
    triggerEveryN?: number;
    maxScenes?: number;
    backupCount?: number;
    sceneBackupCount?: number;
    model?: string;
  };
  embedding?: {
    enabled?: boolean;
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
  };
}

// ============================
// Options
// ============================

export interface OpenClawAdapterOptions {
  /** OpenClaw plugin API */
  api: OpenClawPluginApi;
  /** Plugin data directory */
  pluginDataDir: string;
  /** OpenClaw config */
  openclawConfig: unknown;
  /** Default configuration */
  defaultConfig?: AdapterConfig;
}

// ============================
// OpenClawAdapter
// ============================

export class OpenClawAdapter extends BasePlatformAdapter {
  readonly platformId = "openclaw";
  readonly platformName = "OpenClaw";
  readonly minVersion = "2026.3.13";

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

  private api: OpenClawPluginApi;
  private pluginDataDir: string;
  private openclawConfig: unknown;
  private tdaiCore: TdaiCore | undefined;
  private sessionFilter: SessionFilter | undefined;

  constructor(opts: OpenClawAdapterOptions) {
    super({
      platformId: "openclaw",
      platformName: "OpenClaw",
      minVersion: "2026.3.13",
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

    this.api = opts.api;
    this.pluginDataDir = opts.pluginDataDir;
    this.openclawConfig = opts.openclawConfig;
  }

  // ============================
  // BasePlatformAdapter overrides
  // ============================

  protected createLLMRunnerFactory(): LLMRunnerFactory {
    return new OpenClawLLMRunnerFactory({
      config: this.openclawConfig,
      agentRuntime: this.api.runtime.agent,
      logger: this.api.logger,
    });
  }

  protected createRuntimeContext(): RuntimeContext {
    return {
      userId: "default_user",
      sessionId: "",
      sessionKey: "",
      platform: "openclaw",
      workspaceDir: process.cwd(),
      dataDir: this.pluginDataDir,
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
            cleanTime: { type: "string" },
          },
        },
        extraction: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            enableDedup: { type: "boolean" },
            maxMemoriesPerSession: { type: "number", minimum: 1 },
            model: { type: "string" },
          },
        },
        recall: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            maxResults: { type: "number", minimum: 1, maximum: 20 },
            scoreThreshold: { type: "number", minimum: 0, maximum: 1 },
            strategy: { type: "string", enum: ["hybrid", "embedding", "fts"] },
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
    this.info("Initializing TDAI Core...");

    // Create TdaiCore with OpenClawHostAdapter
    const hostAdapter = {
      hostType: "openclaw" as const,
      getRuntimeContext: () => this.createRuntimeContext(),
      getLogger: () => this.api.logger,
      getLLMRunnerFactory: () => this.createLLMRunnerFactory(),
    };

    const config = this.config as unknown as Record<string, unknown>;
    const parsedConfig = this.parseOpenClawConfig(config);

    this.sessionFilter = new SessionFilter(parsedConfig.capture?.excludeAgents ?? []);

    this.tdaiCore = new TdaiCore({
      hostAdapter,
      config: parsedConfig,
      sessionFilter: this.sessionFilter,
    });

    await this.tdaiCore.initialize();

    this.info("TDAI Core initialized successfully");
  }

  protected async doDispose(): Promise<void> {
    if (this.tdaiCore) {
      this.info("Destroying TDAI Core...");
      await this.tdaiCore.destroy();
      this.tdaiCore = undefined;
    }
  }

  // ============================
  // Memory capability implementations
  // ============================

  async handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult> {
    if (!this.tdaiCore) {
      throw new Error("Adapter not initialized");
    }

    return this.tdaiCore.handleBeforeRecall(userText, sessionKey);
  }

  async handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult> {
    if (!this.tdaiCore) {
      throw new Error("Adapter not initialized");
    }

    return this.tdaiCore.handleTurnCommitted(turn);
  }

  async searchMemories(params: MemorySearchParams): Promise<MemorySearchResult> {
    if (!this.tdaiCore) {
      throw new Error("Adapter not initialized");
    }

    return this.tdaiCore.searchMemories(params);
  }

  async searchConversations(params: ConversationSearchParams): Promise<ConversationSearchResult> {
    if (!this.tdaiCore) {
      throw new Error("Adapter not initialized");
    }

    return this.tdaiCore.searchConversations(params);
  }

  // ============================
  // SKILL: checkEnvironment
  // ============================

  async checkEnvironment(): Promise<{
    passed: boolean;
    issues: Array<{ code: string; message: string; severity: "error" | "warn" }>;
  }> {
    const issues: Array<{ code: string; message: string; severity: "error" | "warn" }> = [];

    // Check OpenClaw version
    const openclawVersion = (this.api.runtime as { version?: string })?.version;
    if (openclawVersion) {
      const minVersion = "2026.3.13";
      if (this.compareVersions(openclawVersion, minVersion) < 0) {
        issues.push({
          code: "OPENCLAW_VERSION",
          message: `OpenClaw ${minVersion}+ required, found ${openclawVersion}`,
          severity: "error",
        });
      }
    }

    // Check Node.js version
    const nodeVersion = process.version;
    const minNodeVersion = "22.16.0";
    if (this.compareVersions(nodeVersion, minNodeVersion) < 0) {
      issues.push({
        code: "NODE_VERSION",
        message: `Node.js ${minNodeVersion}+ required, found ${nodeVersion}`,
        severity: "error",
      });
    }

    // Check data directory
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const dataDirExists = fs.existsSync(this.pluginDataDir);
      if (!dataDirExists) {
        issues.push({
          code: "DATA_DIR",
          message: `Data directory does not exist: ${this.pluginDataDir}`,
          severity: "warn",
        });
      }
    } catch {
      // Ignore fs errors
    }

    return {
      passed: issues.filter(i => i.severity === "error").length === 0,
      issues,
    };
  }

  // ============================
  // SKILL: validateConfig
  // ============================

  async validateConfig(config: AdapterConfig): Promise<{
    valid: boolean;
    errors: Array<{ field: string; message: string }>;
    warnings: Array<{ field: string; message: string }>;
  }> {
    const result = await super.validateConfig(config);

    // Additional OpenClaw-specific validation
    const ocConfig = config as unknown as OpenClawPluginConfig;

    // Check embedding config completeness
    if (ocConfig.embedding?.provider && ocConfig.embedding.provider !== "none") {
      const missing: string[] = [];
      if (!ocConfig.embedding.baseUrl) missing.push("baseUrl");
      if (!ocConfig.embedding.model) missing.push("model");
      if (missing.length > 0) {
        result.warnings.push({
          field: "embedding",
          message: `Embedding provider "${ocConfig.embedding.provider}" configured but missing: ${missing.join(", ")}. Will run in non-vector mode.`,
        });
      }
    }

    return result;
  }

  // ============================
  // SKILL: getHealthStatus
  // ============================

  async getHealthStatus(): Promise<{
    healthy: boolean;
    details: Record<string, unknown>;
  }> {
    const baseStatus = await super.getHealthStatus();

    const details: Record<string, unknown> = {
      ...baseStatus.details,
      pluginDataDir: this.pluginDataDir,
      openclawVersion: (this.api.runtime as { version?: string })?.version,
      nodeVersion: process.version,
    };

    if (this.tdaiCore) {
      details.schedulerStarted = this.tdaiCore.isSchedulerStarted();
      details.vectorStore = !!this.tdaiCore.getVectorStore();
      details.embeddingService = !!this.tdaiCore.getEmbeddingService();
    }

    return {
      healthy: baseStatus.healthy && this.lifecycleState === "ready",
      details,
    };
  }

  // ============================
  // SKILL: exportDiagnostic
  // ============================

  async exportDiagnostic(options: DiagnosticExportOptions = {}): Promise<{
    success: boolean;
    outputPath?: string;
    files?: string[];
  }> {
    const outputDir = options.outputDir ?? `${this.pluginDataDir}/diagnostic-${Date.now()}`;
    const fs = await import("node:fs");
    const path = await import("node:path");

    try {
      // Create output directory
      fs.mkdirSync(outputDir, { recursive: true });

      const exportedFiles: string[] = [];

      // Export environment info
      const envInfo = {
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        openclawVersion: (this.api.runtime as { version?: string })?.version,
        pluginVersion: this.minVersion,
        dataDir: this.pluginDataDir,
        config: options.includeSensitive ? this.config : this.redactSensitiveData(this.config),
      };

      const envInfoPath = path.join(outputDir, "env-info.txt");
      fs.writeFileSync(envInfoPath, JSON.stringify(envInfo, null, 2));
      exportedFiles.push(envInfoPath);

      // Export logs if available
      const logsDir = path.join(this.pluginDataDir, "../logs");
      if (fs.existsSync(logsDir)) {
        const destLogsDir = path.join(outputDir, "logs");
        fs.mkdirSync(destLogsDir, { recursive: true });

        const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith(".log"));
        for (const logFile of logFiles.slice(0, 5)) {
          const srcPath = path.join(logsDir, logFile);
          const destPath = path.join(destLogsDir, logFile);
          fs.copyFileSync(srcPath, destPath);
          exportedFiles.push(destPath);
        }
      }

      // Export memory data if requested
      if (options.includeMemoryData) {
        const memoryDataDir = path.join(outputDir, "memory-data");
        fs.mkdirSync(memoryDataDir, { recursive: true });

        const memorySubdirs = ["conversations", "records", "scene_blocks"];
        for (const subdir of memorySubdirs) {
          const srcDir = path.join(this.pluginDataDir, subdir);
          if (fs.existsSync(srcDir)) {
            const destDir = path.join(memoryDataDir, subdir);
            fs.mkdirSync(destDir, { recursive: true });

            const files = fs.readdirSync(srcDir).slice(0, 10);
            for (const file of files) {
              const srcPath = path.join(srcDir, file);
              const destPath = path.join(destDir, file);
              fs.copyFileSync(srcPath, destPath);
            }
          }
        }
        exportedFiles.push(memoryDataDir);
      }

      this.info(`Diagnostic exported to: ${outputDir}`);

      return {
        success: true,
        outputPath: outputDir,
        files: exportedFiles,
      };
    } catch (error) {
      this.error(`Diagnostic export failed: ${error}`);
      return {
        success: false,
        outputPath: outputDir,
        files: [],
      };
    }
  }

  // ============================
  // SKILL: install (placeholder)
  // ============================

  async install(options: { dryRun?: boolean } = {}): Promise<{ success: boolean; message?: string }> {
    this.info("Installation check...");

    const envCheck = await this.checkEnvironment();
    if (!envCheck.passed) {
      return {
        success: false,
        message: `Environment check failed: ${envCheck.issues.map(i => i.message).join(", ")}`,
      };
    }

    if (options.dryRun) {
      return { success: true, message: "Dry run successful" };
    }

    return { success: true, message: "Plugin is ready to use" };
  }

  // ============================
  // SKILL: migrate (placeholder)
  // ============================

  async migrate(_oldVersion: string): Promise<{ success: boolean; message?: string }> {
    this.info("Migration check...");

    // Check for old plugin data
    const fs = await import("node:fs");
    const path = await import("node:path");

    const oldDataDir = path.join(this.pluginDataDir, "../../memory-tdai");
    const oldDataExists = fs.existsSync(oldDataDir);

    if (!oldDataExists) {
      return { success: true, message: "No old data found, nothing to migrate" };
    }

    return { success: true, message: "Migration check complete" };
  }

  // ============================
  // Private helpers
  // ============================

  private parseOpenClawConfig(config: Record<string, unknown>): Record<string, unknown> {
    // Parse and normalize OpenClaw config format
    return {
      ...config,
      // Ensure nested defaults
      capture: {
        enabled: true,
        excludeAgents: [],
        ...(config.capture as Record<string, unknown>),
      },
      recall: {
        enabled: true,
        maxResults: 5,
        scoreThreshold: 0.3,
        strategy: "hybrid",
        ...(config.recall as Record<string, unknown>),
      },
      extraction: {
        enabled: true,
        enableDedup: true,
        maxMemoriesPerSession: 10,
        ...(config.extraction as Record<string, unknown>),
      },
      embedding: {
        enabled: false,
        provider: "none",
        ...(config.embedding as Record<string, unknown>),
      },
    };
  }

  private redactSensitiveData(config: AdapterConfig): AdapterConfig {
    const redacted = { ...config };
    const sensitiveFields = ["apiKey", "token", "password", "secret", "credential"];

    const redactObject = (obj: Record<string, unknown>): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (sensitiveFields.some(f => key.toLowerCase().includes(f))) {
          result[key] = "***REDACTED***";
        } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          result[key] = redactObject(value as Record<string, unknown>);
        } else {
          result[key] = value;
        }
      }
      return result;
    };

    return redactObject(redacted as Record<string, unknown>) as AdapterConfig;
  }
}
