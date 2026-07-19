export interface MemoryAdapterRuntime {
  platform: string;
  userId: string;
  sessionId: string;
  sessionKey: string;
  workspaceDir: string;
}

export interface MemoryTurnPayload {
  userContent: string;
  assistantContent: string;
  messages?: unknown[];
}

export interface MemoryPlatformBridge {
  getRuntime(): MemoryAdapterRuntime;
  buildTurn?(turn: MemoryTurnPayload): MemoryTurnPayload;
}

export interface MemoryPromptContext {
  /** Add to the current user prompt before the raw query. */
  prependUserContext: string;
  /** Add to the system prompt or platform-level instruction suffix. */
  appendSystemContext: string;
}

export function normalizeSessionPart(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/\s+/g, "-");
}
