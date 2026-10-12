import type { Logger } from "../types.js";

export async function writeGenerationProvenanceBestEffort(params: {
  layer: "l1" | "l2" | "l3";
  logger?: Logger;
  writeLog: () => Promise<void>;
  writeRefs?: () => Promise<void>;
}): Promise<void> {
  const { layer, logger, writeLog, writeRefs } = params;
  try {
    await writeLog();
  } catch (error) {
    logger?.warn?.(
      `[memory-generation-log] ${layer} log write failed; memory generation remains successful: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (!writeRefs) return;
  try {
    await writeRefs();
  } catch (error) {
    logger?.warn?.(
      `[memory-generation-log] ${layer} reference write failed; memory generation remains successful: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
