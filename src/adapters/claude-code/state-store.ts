import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface ClaudeCodeStoredTurn {
  id: string;
  userText: string;
  userTimestamp: number;
  assistantText?: string;
  assistantTimestamp?: number;
}

export interface ClaudeCodeSessionState {
  version: 1;
  sessionId: string;
  sessionKey: string;
  turns: ClaudeCodeStoredTurn[];
}

/**
 * Persistent per-session queue shared by separate Claude Code hook processes.
 * File names are hashes, so an untrusted session id can never become a path.
 */
export class ClaudeCodeStateStore {
  constructor(private readonly rootDir: string) {}

  async load(sessionId: string, sessionKey: string): Promise<ClaudeCodeSessionState> {
    const file = this.fileFor(sessionId);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyState(sessionId, sessionKey);
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isSessionState(parsed, sessionId)) throw new Error("invalid state shape");
      return parsed;
    } catch {
      // Preserve the damaged file for diagnosis instead of silently replacing it.
      const backup = `${file}.corrupt-${Date.now()}`;
      await fs.rename(file, backup).catch(() => undefined);
      return emptyState(sessionId, sessionKey);
    }
  }

  async save(state: ClaudeCodeSessionState): Promise<void> {
    const file = this.fileFor(state.sessionId);
    if (state.turns.length === 0) {
      await fs.rm(file, { force: true });
      return;
    }

    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600).catch(() => undefined);
  }

  private fileFor(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return path.join(this.rootDir, "sessions", `${digest}.json`);
  }
}

function emptyState(sessionId: string, sessionKey: string): ClaudeCodeSessionState {
  return { version: 1, sessionId, sessionKey, turns: [] };
}

function isSessionState(value: unknown, expectedSessionId: string): value is ClaudeCodeSessionState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ClaudeCodeSessionState>;
  if (
    state.version !== 1 ||
    state.sessionId !== expectedSessionId ||
    typeof state.sessionKey !== "string" ||
    !Array.isArray(state.turns)
  ) {
    return false;
  }

  return state.turns.every((turn) => {
    if (!turn || typeof turn !== "object") return false;
    const candidate = turn as Partial<ClaudeCodeStoredTurn>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.userText === "string" &&
      typeof candidate.userTimestamp === "number" &&
      (candidate.assistantText === undefined || typeof candidate.assistantText === "string") &&
      (candidate.assistantTimestamp === undefined || typeof candidate.assistantTimestamp === "number")
    );
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
