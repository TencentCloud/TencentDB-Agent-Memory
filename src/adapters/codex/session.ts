import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

interface PromptRecord {
  sessionId: string;
  turnId: string;
  prompt: string;
}

interface CodexSessionStateOptions {
  stateTtlMs?: number;
  claimTtlMs?: number;
}

const DEFAULT_STATE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CLAIM_TTL_MS = 60_000;

export function codexSessionKey(sessionId: string): string {
  return `codex:${sessionId}`;
}

export function defaultCodexStateDir(): string {
  const root = process.env.MEMORY_TENCENTDB_ROOT
    ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".memory-tencentdb");
  return process.env.TDAI_CODEX_STATE_DIR ?? path.join(root, "codex-adapter");
}

export class CodexSessionState {
  private readonly stateTtlMs: number;
  private readonly claimTtlMs: number;

  constructor(
    private readonly stateDir = defaultCodexStateDir(),
    options: CodexSessionStateOptions = {},
  ) {
    this.stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  }

  async savePrompt(sessionId: string, turnId: string, prompt: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await this.cleanupExpiredState();
    const target = this.promptPath(sessionId, turnId);
    const temp = `${target}.${randomUUID()}.tmp`;
    const record: PromptRecord = {
      sessionId,
      turnId,
      prompt,
    };
    await writeFile(temp, JSON.stringify(record), { encoding: "utf-8", mode: 0o600 });
    await rename(temp, target);
  }

  async getPrompt(sessionId: string, turnId: string): Promise<string | undefined> {
    return (await this.getPromptRecord(sessionId, turnId))?.prompt;
  }

  async getPromptRecord(sessionId: string, turnId: string): Promise<PromptRecord | undefined> {
    await this.cleanupExpiredState();
    try {
      const raw = await readFile(this.promptPath(sessionId, turnId), "utf-8");
      const record = JSON.parse(raw) as Partial<PromptRecord>;
      if (typeof record.prompt !== "string") return undefined;
      return {
        sessionId,
        turnId,
        prompt: record.prompt,
      };
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async isCaptured(sessionId: string, turnId: string): Promise<boolean> {
    await this.cleanupExpiredState();
    try {
      await stat(this.capturedPath(sessionId, turnId));
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  async beginCapture(sessionId: string, turnId: string): Promise<boolean> {
    await mkdir(this.stateDir, { recursive: true });
    await this.cleanupExpiredState();
    if (await this.isCaptured(sessionId, turnId)) return false;

    const claimPath = this.claimPath(sessionId, turnId);
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

  async releaseCapture(sessionId: string, turnId: string): Promise<void> {
    await rm(this.claimPath(sessionId, turnId), { force: true });
  }

  async markCaptured(sessionId: string, turnId: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.capturedPath(sessionId, turnId), "captured\n", { encoding: "utf-8", mode: 0o600 });
    await Promise.all([
      rm(this.promptPath(sessionId, turnId), { force: true }),
      rm(this.claimPath(sessionId, turnId), { force: true }),
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

  private promptPath(sessionId: string, turnId: string): string {
    return path.join(this.stateDir, `${recordKey(sessionId, turnId)}.prompt.json`);
  }

  private claimPath(sessionId: string, turnId: string): string {
    return path.join(this.stateDir, `${recordKey(sessionId, turnId)}.capture.claim`);
  }

  private capturedPath(sessionId: string, turnId: string): string {
    return path.join(this.stateDir, `${recordKey(sessionId, turnId)}.captured`);
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

function recordKey(sessionId: string, turnId: string): string {
  return createHash("sha256").update(`${sessionId}\0${turnId}`).digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isStateFile(name: string): boolean {
  return name.endsWith(".prompt.json") || name.endsWith(".capture.claim") || name.endsWith(".captured");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
