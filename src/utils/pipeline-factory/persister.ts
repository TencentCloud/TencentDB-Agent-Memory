/** Persister: saves pipeline session states to the checkpoint file. */

import { CheckpointManager } from "../checkpoint.js";
import type { PipelineSessionState } from "../checkpoint.js";
import type { PipelineLogger } from "./types.js";

const TAG = "[memory-tdai] [pipeline-factory]";

export function createPersister(
  pluginDataDir: string,
  logger: PipelineLogger,
): (states: Record<string, PipelineSessionState>) => Promise<void> {
  return async (states) => {
    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    const keys = Object.keys(states);
    logger.debug?.(`${TAG} persisting ${keys.length} session state(s): ${keys.join(",") || "(none)"}`);
    await checkpoint.mergePipelineStates(states);
  };
}
