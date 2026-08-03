/** Persister: saves pipeline session states to the checkpoint file. */

import { CheckpointManager } from "../checkpoint.js";
import type { PipelineSessionState } from "../checkpoint.js";
import type { PipelineLogger } from "./types.js";

export function createPersister(
  pluginDataDir: string,
  logger: PipelineLogger,
): (states: Record<string, PipelineSessionState>) => Promise<void> {
  return async (states) => {
    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    await checkpoint.mergePipelineStates(states);
  };
}
