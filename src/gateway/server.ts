/**
 * TDAI Gateway — HTTP server for the Hermes sidecar.
 *
 * Extends HttpServerBase with:
 *   - YAML-based config via loadGatewayConfig
 *   - POST /seed endpoint (handleCustomRoute override)
 *   - Security posture logging at startup (onAfterInit override)
 *   - buildMemoryConfig override to pass pre-parsed MemoryTdaiConfig
 *
 * External API is unchanged: new TdaiGateway(overrides?), start(), stop().
 */

import http from "node:http";
import { HttpServerBase, parseJsonBody, sendJson } from "../adapters/http-server-base.js";
import { StandaloneHostAdapter } from "../adapters/standalone/host-adapter.js";
import { loadGatewayConfig } from "./config.js";
import type { GatewayConfig } from "./config.js";
import { SessionFilter } from "../utils/session-filter.js";
import type { HostAdapter } from "../core/types.js";
import type { MemoryTdaiConfig } from "../config.js";
import type {
  SeedRequest,
  SeedResponse,
} from "./types.js";
import { validateAndNormalizeRaw, SeedValidationError } from "../core/seed/input.js";
import { executeSeed } from "../core/seed/seed-runtime.js";
import type { SeedProgress } from "../core/seed/types.js";
import type { Logger } from "../core/types.js";

// ============================
// Console logger (for standalone gateway — no OpenClaw logger available)
// ============================

function createConsoleLogger(): Logger {
  return {
    debug: (msg: string) => console.debug(msg),
    info: (msg: string) => console.info(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };
}

// ============================
// TdaiGateway
// ============================

export class TdaiGateway extends HttpServerBase {
  private config: GatewayConfig;

  constructor(configOverrides?: Partial<GatewayConfig>) {
    const config = loadGatewayConfig(configOverrides);

    super({
      dataDir: config.data.baseDir,
      llmConfig: config.llm,
      port: config.server.port,
      host: config.server.host,
      apiKey: config.server.apiKey,
      corsOrigins: config.server.corsOrigins,
      userId: undefined,
      logger: createConsoleLogger(),
      sessionFilter: new SessionFilter(config.memory.capture.excludeAgents),
    });

    this.config = config;
  }

  protected createAdapter(): HostAdapter {
    return new StandaloneHostAdapter({
      dataDir: this.config.data.baseDir,
      llmConfig: this.config.llm,
      logger: this.logger,
      platform: "gateway",
    });
  }

  protected buildMemoryConfig(): MemoryTdaiConfig {
    return this.config.memory;
  }

  protected async onAfterInit(): Promise<void> {
    this.logSecurityPosture();
  }

  // ============================
  // /seed custom route
  // ============================

  protected async handleCustomRoute(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    if (method === "POST" && pathname === "/seed") {
      await this.handleSeed(req, res);
      return true;
    }
    return false;
  }

  private async handleSeed(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SeedRequest>(req);

    if (!body.data) {
      sendJson(res, 400, { error: "Missing required field: data" });
      return;
    }

    let input;
    try {
      input = validateAndNormalizeRaw(body.data, {
        sessionKey: body.session_key,
        strictRoundRole: body.strict_round_role,
        autoFillTimestamps: body.auto_fill_timestamps ?? true,
      });
    } catch (err) {
      if (err instanceof SeedValidationError) {
        sendJson(res, 400, {
          error: err.message,
          validation_errors: err.errors,
        });
        return;
      }
      throw err;
    }

    this.logger.info(
      `Seed request: ${input.sessions.length} session(s), ` +
      `${input.totalRounds} round(s), ${input.totalMessages} message(s)`,
    );

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const outputDir = `${this.config.data.baseDir}/seed-${ts}`;

    const baseConfig = this.config.memory as unknown as Record<string, unknown>;
    let pluginConfig: Record<string, unknown> = {
      ...baseConfig,
      llm: {
        enabled: true,
        baseUrl: this.config.llm.baseUrl,
        apiKey: this.config.llm.apiKey,
        model: this.config.llm.model,
        maxTokens: this.config.llm.maxTokens,
        timeoutMs: this.config.llm.timeoutMs,
        disableThinking: this.config.llm.disableThinking,
      },
    };
    if (body.config_override) {
      for (const key of Object.keys(body.config_override)) {
        const baseVal = pluginConfig[key];
        const overVal = body.config_override[key];
        if (baseVal && typeof baseVal === "object" && !Array.isArray(baseVal) &&
            overVal && typeof overVal === "object" && !Array.isArray(overVal)) {
          pluginConfig[key] = { ...(baseVal as Record<string, unknown>), ...(overVal as Record<string, unknown>) };
        } else {
          pluginConfig[key] = overVal;
        }
      }
    }

    const summary = await executeSeed(input, {
      outputDir,
      openclawConfig: {},
      pluginConfig,
      logger: this.logger as import("../utils/pipeline-factory.js").PipelineLogger,
      onProgress: (progress: SeedProgress) => {
        this.logger.debug?.(
          `Seed progress: [${progress.currentRound}/${progress.totalRounds}] ` +
          `session=${progress.sessionKey} stage=${progress.stage}`,
        );
      },
    });

    this.logger.info(
      `Seed complete: sessions=${summary.sessionsProcessed}, rounds=${summary.roundsProcessed}, ` +
      `l0=${summary.l0RecordedCount}, duration=${(summary.durationMs / 1000).toFixed(1)}s`,
    );

    const response: SeedResponse = {
      sessions_processed: summary.sessionsProcessed,
      rounds_processed: summary.roundsProcessed,
      messages_processed: summary.messagesProcessed,
      l0_recorded: summary.l0RecordedCount,
      duration_ms: summary.durationMs,
      output_dir: summary.outputDir,
    };
    sendJson(res, 200, response);
  }

  // ============================
  // Security posture logging
  // ============================

  /**
   * Emit a one-shot security posture summary at startup.
   *
   * Goals:
   *   1. Make the "auth disabled" state highly visible to anyone reading logs.
   *   2. Loudly warn when the gateway is bound to anything other than loopback
   *      without an API key — that combination is the real exposure.
   *   3. Never log the key itself.
   */
  private logSecurityPosture(): void {
    const { host, apiKey, corsOrigins } = this.config.server;
    const authOn = !!apiKey;
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

    this.logger.info(
      `Security posture: auth=${authOn ? "ENABLED (Bearer)" : "disabled"} ` +
      `host=${host} cors=${corsOrigins.length === 0 ? "no-headers" : corsOrigins.includes("*") ? "wildcard(*)" : `allowlist(${corsOrigins.length})`}`,
    );

    if (!authOn) {
      this.logger.warn(
        "TDAI_GATEWAY_API_KEY is NOT set — all routes except GET /health are " +
        "open to anyone who can reach this port. This is the legacy default. " +
        "Set TDAI_GATEWAY_API_KEY (or server.apiKey in tdai-gateway.yaml) and " +
        "pass `Authorization: Bearer <key>` from clients before exposing the " +
        "gateway beyond the loopback interface.",
      );
    }
    if (!loopback && !authOn) {
      this.logger.warn(
        `Gateway is bound to ${host} (non-loopback) WITHOUT an API key. ` +
        "Every /capture, /search/conversations, /recall, /seed call from the " +
        "network is currently unauthenticated. Bind to 127.0.0.1, or set " +
        "TDAI_GATEWAY_API_KEY, before continuing.",
      );
    }
    if (corsOrigins.includes("*")) {
      this.logger.warn(
        "CORS allow-list contains '*' — every browser origin can call this " +
        "gateway. Restrict server.corsOrigins to a concrete allow-list for any " +
        "non-local deployment.",
      );
    }
  }
}

// ============================
// CLI entry point
// ============================

async function main(): Promise<void> {
  const gateway = new TdaiGateway();
  await gateway.start();
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  main().catch((err) => {
    console.error("Gateway startup failed:", err);
    process.exit(1);
  });
}
