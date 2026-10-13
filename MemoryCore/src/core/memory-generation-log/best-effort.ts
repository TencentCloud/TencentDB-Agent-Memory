import type { Logger } from "../types.js";

export async function writeGenerationProvenanceBestEffort(params: {
  layer: "l1" | "l2" | "l3";
  logger?: Logger;
  writeLog: () => Promise<void>;
  writeRefs?: () => void | Promise<void>;
}): Promise<void> {
  const { layer, logger, writeLog, writeRefs } = params;
  try {
    await writeLog();
  } catch {
    logger?.warn?.(
      `[memory-generation-log] ${layer} log write failed; memory generation remains successful`,
    );
    return;
  }

  if (!writeRefs) return;
  try {
    await writeRefs();
  } catch {
    logger?.warn?.(
      `[memory-generation-log] ${layer} reference write failed; memory generation remains successful`,
    );
  }
}
