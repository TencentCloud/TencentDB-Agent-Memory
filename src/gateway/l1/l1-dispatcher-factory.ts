import path from "node:path";
import type { MemoryTdaiConfig } from "../../config.js";
import type { Logger } from "../../core/types.js";
import { buildRoleDefaults } from "../role-defaults.js";
import { resolveRoleDirForRead } from "../role-files.js";
import { createLauncherRegistry } from "../consolidation/launchers/registry.js";
import { GatewayL1AgentDispatcher } from "./l1-agent-dispatcher.js";

export function defaultL1ScratchRoot(dataDir: string): string {
  return path.join(
    path.dirname(dataDir),
    `${path.basename(dataDir)}-agent-scratch`,
  );
}

export function createGatewayL1Dispatcher(input: {
  dataDir: string;
  scratchRoot?: string;
  config: MemoryTdaiConfig;
  logger: Logger;
}): GatewayL1AgentDispatcher {
  return new GatewayL1AgentDispatcher({
    dataDir: input.dataDir,
    scratchRoot: input.scratchRoot ?? defaultL1ScratchRoot(input.dataDir),
    roleDir: resolveRoleDirForRead(input.dataDir),
    roleDefaults: buildRoleDefaults(input.config.consolidation),
    launcherFor: createLauncherRegistry(
      input.config.consolidation.launchers,
      input.logger,
    ),
    logger: input.logger,
    maxMemoriesPerSession: input.config.extraction.maxMemoriesPerSession,
  });
}
