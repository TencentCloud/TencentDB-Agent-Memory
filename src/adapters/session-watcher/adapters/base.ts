/**
 * SessionAdapter — abstract interface for reading agent conversation data.
 *
 * Adding a new agent = create `adapters/<name>.ts` implementing this interface
 * and register it in the ADAPTER_MAP.
 */

export interface ParsedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: number;
}

export interface ParsedTurn {
  sessionKey: string;
  sessionId: string;
  userMessage: ParsedMessage;
  assistantMessages: ParsedMessage[];
}

export interface SessionInfo {
  sessionKey: string;
  sessionId: string;
  projectPath?: string;
  startedAt?: string;
}

export interface SessionAdapter {
  /** Unique adapter name (e.g. "opencode", "codex"). */
  readonly name: string;
  /** Root directory where this agent stores its sessions. */
  sessionDir(): string;
  /** Discover all active/available sessions. */
  discoverSessions(): Promise<SessionInfo[]>;
  /**
   * Parse messages from a session, returning only messages NEWER than the
   * given cursor timestamp / message index.
   * @param sessionKey - session identifier
   * @param sinceTimestamp - epoch ms cursor: return only messages after this time
   * @returns parsed messages in chronological order
   */
  parseNewMessages(
    sessionKey: string,
    sinceTimestamp: number,
  ): Promise<ParsedMessage[]>;
  /**
   * Group raw messages into conversation turns.
   * A turn = one user message + following assistant messages until next user.
   */
  detectTurns(messages: ParsedMessage[]): ParsedTurn[];
}

/** Registry of available adapters. */
export const ADAPTER_MAP = new Map<string, () => SessionAdapter>();

export function registerAdapter(name: string, factory: () => SessionAdapter) {
  ADAPTER_MAP.set(name, factory);
}

export function getAdapter(name: string): SessionAdapter | undefined {
  const factory = ADAPTER_MAP.get(name);
  return factory?.();
}
