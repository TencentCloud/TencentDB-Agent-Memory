import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface PromptRecord {
  sessionId: string;
  promptId: string;
  prompt: string;
}

interface LatestPromptRecord {
  promptId: string;
}

interface ClaudeCodeSessionStateOptions {
  stateTtlMs?: number;
  claimTtlMs?: number;
}

const DEFAULT_STATE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CLAIM_TTL_MS = 60_000;

export function claudeCodeSessionKey(sessionId: string): string {
  return `claude-code:${sessionId}`;
}

export function defaultClaudeCodeStateDir(): string {
  const root = process.env.MEMORY_TENCENTDB_ROOT
    ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".memory-tencentdb");
  return process.env.TDAI_CLAUDE_CODE_STATE_DIR ?? path.join(root, "claude-code-adapter");
}

export class ClaudeCodeSessionState {
  private readonly stateTtlMs: number;
  private readonly claimTtlMs: number;

  constructor(
    private readonly stateDir = defaultClaudeCodeStateDir(),
    options: ClaudeCodeSessionStateOptions = {},
  ) {
    this.stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  }

  async savePrompt(sessionId: string, promptId: string, prompt: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await this.cleanupExpiredState();
    const target = this.promptPath(sessionId, promptId);
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ sessionId, promptId, prompt } satisfies PromptRecord), {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async saveLatestPrompt(sessionId: string, prompt: string): Promise<string> {
    const promptId = `fallback:${randomUUID()}`;
    await this.savePrompt(sessionId, promptId, prompt);
    const target = this.latestPromptPath(sessionId);
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ promptId } satisfies LatestPromptRecord), {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return promptId;
  }

  async getLatestPromptRecord(sessionId: string): Promise<PromptRecord | undefined> {
    await this.cleanupExpiredState();
    try {
      const raw = await readFile(this.latestPromptPath(sessionId), "utf-8");
      const record = JSON.parse(raw) as Partial<LatestPromptRecord>;
      if (typeof record.promptId !== "string") return undefined;
      return this.getPromptRecord(sessionId, record.promptId);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async getPrompt(sessionId: string, promptId: string): Promise<string | undefined> {
    return (await this.getPromptRecord(sessionId, promptId))?.prompt;
  }

  async getPromptRecord(sessionId: string, promptId: string): Promise<PromptRecord | undefined> {
    await this.cleanupExpiredState();
    try {
      const raw = await readFile(this.promptPath(sessionId, promptId), "utf-8");
      const record = JSON.parse(raw) as Partial<PromptRecord>;
      if (typeof record.prompt !== "string") return undefined;
      return { sessionId, promptId, prompt: record.prompt };
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async isCaptured(sessionId: string, promptId: string): Promise<boolean> {
    await this.cleanupExpiredState();
    try {
      await stat(this.capturedPath(sessionId, promptId));
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  async beginCapture(sessionId: string, promptId: string): Promise<boolean> {
    await mkdir(this.stateDir, { recursive: true });
    await this.cleanupExpiredState();
    if (await this.isCaptured(sessionId, promptId)) return false;

    const claimPath = this.claimPath(sessionId, promptId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(claimPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, claimedAt: Date.now() }));
        await handle.close();
        return true;
      } catch (error) {
        if (!isExistingFile(error)) throw error;
        if (attempt > 0 || !await this.isClaimStale(claimPath)) return false;
        await rm(claimPath, { force: true });
      }
    }
    return false;
  }

  async releaseCapture(sessionId: string, promptId: string): Promise<void> {
    await rm(this.claimPath(sessionId, promptId), { force: true });
  }

  async markCaptured(sessionId: string, promptId: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.capturedPath(sessionId, promptId), "captured\n", { encoding: "utf-8", mode: 0o600 });
    await Promise.all([
      rm(this.promptPath(sessionId, promptId), { force: true }),
      rm(this.claimPath(sessionId, promptId), { force: true }),
    ]);
  }

  async cleanupExpiredState(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.stateDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }

    const now = Date.now();
    await Promise.all(entries
      .filter((entry) => entry.isFile() && isStateFile(entry.name))
      .map(async (entry) => {
        const file = path.join(this.stateDir, entry.name);
        const metadata = await stat(file);
        const ttl = entry.name.endsWith(".capture.claim") ? this.claimTtlMs : this.stateTtlMs;
        if (metadata.mtimeMs < now - ttl) await rm(file, { force: true });
      }));
  }

  private promptPath(sessionId: string, promptId: string): string {
    return path.join(this.stateDir, `${recordKey(sessionId, promptId)}.prompt.json`);
  }

  private claimPath(sessionId: string, promptId: string): string {
    return path.join(this.stateDir, `${recordKey(sessionId, promptId)}.capture.claim`);
  }

  private capturedPath(sessionId: string, promptId: string): string {
    return path.join(this.stateDir, `${recordKey(sessionId, promptId)}.captured`);
  }

  private latestPromptPath(sessionId: string): string {
    return path.join(this.stateDir, `${sessionKey(sessionId)}.latest-prompt.json`);
  }

  private async isClaimStale(claimPath: string): Promise<boolean> {
    try {
      const metadata = await stat(claimPath);
      if (metadata.mtimeMs < Date.now() - this.claimTtlMs) return true;
      const claim = JSON.parse(await readFile(claimPath, "utf-8")) as { pid?: unknown };
      return typeof claim.pid !== "number" || !isProcessRunning(claim.pid);
    } catch (error) {
      if (isMissingFile(error)) return true;
      return false;
    }
  }
}

function recordKey(sessionId: string, promptId: string): string {
  return createHash("sha256").update(`${sessionId}\0${promptId}`).digest("hex");
}

function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isStateFile(name: string): boolean {
  return name.endsWith(".prompt.json")
    || name.endsWith(".latest-prompt.json")
    || name.endsWith(".capture.claim")
    || name.endsWith(".captured")
    || isPromptTempFile(name);
}

function isPromptTempFile(name: string): boolean {
  return /^[a-f0-9]{64}\.(?:prompt|latest-prompt)\.json\.[0-9a-f-]{36}\.tmp$/.test(name);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}