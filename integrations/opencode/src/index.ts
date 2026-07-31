import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { loadOpenCodeAdapterConfig } from "./config.js";
import { GatewayClient } from "./gateway-client.js";
import { GatewaySupervisor } from "./gateway-supervisor.js";
import { createOpenCodeLogger } from "./logger.js";
import { MemoryService } from "./memory-service.js";
import { OpenCodeMemoryRuntime } from "./plugin-runtime.js";
import { ResultFormatter } from "./result-formatter.js";
import { SessionResolver } from "./session-resolver.js";
import { SessionTracker } from "./session-tracker.js";
import { createMemoryTools } from "./tools.js";

export const MemoryTencentdbOpenCodePlugin: Plugin = async (
  { client, directory },
  options,
) => {
  const logger = createOpenCodeLogger(client);
  const config = loadOpenCodeAdapterConfig(process.env, logger, options);
  const gatewayClient = new GatewayClient({
    baseUrl: config.gatewayUrl,
    timeoutMs: config.requestTimeoutMs,
    apiKey: config.gatewayApiKey,
  });
  const supervisor = new GatewaySupervisor({
    client: gatewayClient,
    gatewayUrl: config.gatewayUrl,
    gatewayCommand: config.gatewayCommand,
    logDir: config.logDir,
    startupTimeoutMs: config.startupTimeoutMs,
    enabled: config.enableSupervisor,
    logger,
  });
  const service = new MemoryService(gatewayClient, supervisor);
  const runtime = new OpenCodeMemoryRuntime(
    config,
    client,
    directory,
    service,
    new SessionResolver({
      cwd: directory,
      explicitSessionKey: config.explicitSessionKey,
    }),
    new SessionTracker(join(config.logDir, "capture-state.json"), logger),
    new ResultFormatter(config.resultMaxChars),
    logger,
  );

  void supervisor.ensureRunning().then((available) => {
    if (available) logger.info(`Gateway connected at ${config.gatewayUrl}.`);
    else
      logger.warn(
        "Gateway is unavailable; memory operations will degrade until recovery succeeds.",
      );
  });

  return {
    tool: createMemoryTools(runtime, service),

    "chat.message": async (input, output) => {
      const context = await runtime.recallForMessage(
        input.sessionID,
        output.message.id,
        output.parts,
      );
      if (!context) return;
      output.parts.push({
        id: `memory-tencentdb-${randomUUID()}`,
        messageID: output.message.id,
        sessionID: input.sessionID,
        type: "text",
        text: context,
        synthetic: true,
      } as (typeof output.parts)[number]);
    },

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await runtime.captureSession(event.properties.sessionID);
        return;
      }
      if (event.type === "session.deleted") {
        await runtime.endSession(event.properties.info.id, true);
      }
    },

    dispose: async () => {
      await runtime.dispose();
      await supervisor.shutdown();
    },
  };
};
