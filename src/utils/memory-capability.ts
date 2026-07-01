type MemoryCapabilityApi = {
  registerMemoryCapability?: (capability: Record<string, never>) => void;
};

type CapabilityLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

const TAG = "[memory-tdai]";

export function registerMemoryCapabilityIfAvailable(
  api: MemoryCapabilityApi,
  logger?: CapabilityLogger,
): boolean {
  if (typeof api.registerMemoryCapability !== "function") {
    logger?.debug?.(`${TAG} registerMemoryCapability unavailable; skipping memory slot declaration`);
    return false;
  }

  try {
    api.registerMemoryCapability({});
    logger?.debug?.(`${TAG} Memory capability registered for host doctor checks`);
    return true;
  } catch (err) {
    logger?.warn?.(
      `${TAG} registerMemoryCapability failed; continuing without host memory slot declaration: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
