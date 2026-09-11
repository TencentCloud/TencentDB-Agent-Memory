import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface OpenCodeRecallRecord {
  sessionId: string;
  userMessageId: string;
  context: string;
}

interface OpenCodeSessionStateOptions {
  stateTtlMs?: number;
  claimTtlMs?: number;
}

const DEFAULT_STATE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CLAIM_TTL_MS = 60_000;

export function opencodeSessionKey(sessionId: string): string {
  return `opencode:${sessionId}`;
}

export function defaultOpenCodeStateDir(): string {
  const root = process.env.MEMORY_TENCENTDB_ROOT
    ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".memory-tencentdb");
  return process.env.TDAI_OPENCODE_STATE_DIR ?? path.join(root, "opencode-adapter");
}

export class OpenCodeSessionState {
  private readonly stateTtlMs: number;
  private readonly claimTtlMs: number;

  constructor(
    private readonly stateDir = defaultOpenCodeStateDir(),
    options: OpenCodeSessionStateOptions = {},
  ) {
    this.stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  }

  async beginRecall(sessionId: string, userMessageId: string): Promise<boolean> {
    await mkdir(this.stateDir, { recursive: true });
    await this.cleanupExpiredState();
    if (
      await exists(this.recallPath(sessionId, userMessageId))
      || await exists(this.recallInjectedPath(sessionId, userMessageId))
    ) return false;
    return this.claim(this.recallClaimPath(sessionId, userMessageId));
  }

  async releaseRecall(sessionId: string, userMessageId: string): Promise<void> {
    await rm(this.recallClaimPath(sessionId, userMessageId), { force: true });
  }

  async saveRecall(sessionId: string, userMessageId: string, context: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const record = { sessionId, userMessageId, context } satisfies OpenCodeRecallRecord;
    await this.atomicWrite(this.recallPath(sessionId, userMessageId), JSON.stringify(record));
    await this.releaseRecall(sessionId, userMessageId);
  }

  async consumeRecall(sessionId: string): Promise<OpenCodeRecallRecord | undefined> {
    await this.cleanupExpiredState();
    const activeUserMessageId = await this.getActiveRecall(sessionId);
    if (!activeUserMessageId) return undefined;
    const file = this.recallPath(sessionId, activeUserMessageId);
    const consuming = `${file}.${randomUUID()}.consuming`;
    try {
      await rename(file, consuming);
      const record = JSON.parse(await readFile(consuming, "utf-8")) as Partial<OpenCodeRecallRecord>;
      if (
        record.sessionId !== sessionId
        || record.userMessageId !== activeUserMessageId
        || typeof record.context !== "string"
      ) return undefined;
      await writeFile(this.recallInjectedPath(sessionId, activeUserMessageId), "injected\n", {
        encoding: "utf-8",
        mode: 0o600,
      });
      return { sessionId, userMessageId: activeUserMessageId, context: record.context };
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    } finally {
      await Promise.all([
        rm(consuming, { force: true }),
        rm(this.activeRecallPath(sessionId), { force: true }),
      ]);
    }
  }

  async setActiveRecall(sessionId: string, userMessageId: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await this.atomicWrite(this.activeRecallPath(sessionId), JSON.stringify({ userMessageId }));
  }

  async beginSessionEnd(sessionId: string): Promise<boolean> {
    await mkdir(this.stateDir, { recursive: true });
    await this.cleanupExpiredState();
    if (await exists(this.sessionEndedPath(sessionId))) return false;
    return this.claim(this.sessionEndClaimPath(sessionId));
  }

  async releaseSessionEnd(sessionId: string): Promise<void> {
    await rm(this.sessionEndClaimPath(sessionId), { force: true });
  }

  async markSessionEnded(sessionId: string): Promise<void> {
    await writeFile(this.sessionEndedPath(sessionId), "ended\n", { encoding: "utf-8", mode: 0o600 });
    await this.releaseSessionEnd(sessionId);
  }

  private async getActiveRecall(sessionId: string): Promise<string | undefined> {
    try {
      const value = JSON.parse(await readFile(this.activeRecallPath(sessionId), "utf-8")) as { userMessageId?: unknown };
      return typeof value.userMessageId === "string" ? value.userMessageId : undefined;
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  private activeRecallPath(sessionId: string): string {
    return path.join(this.stateDir, `${sessionHash(sessionId)}.active-recall.json`);
  }

  private sessionEndClaimPath(sessionId: string): string {
    return path.join(this.stateDir, `${sessionHash(sessionId)}.session-end.claim`);
  }

  private sessionEndedPath(sessionId: string): string {
    return path.join(this.stateDir, `${sessionHash(sessionId)}.session-ended`);
  }

  async beginCapture(sessionId: string, userMessageId: string, assistantMessageId: string): Promise<boolean> {
    await mkdir(this.stateDir, { recursive: true });
    await this.cleanupExpiredState();
    if (await this.isCaptured(sessionId, userMessageId, assistantMessageId)) return false;
    return this.claim(this.captureClaimPath(sessionId, userMessageId, assistantMessageId));
  }

  async releaseCapture(sessionId: string, userMessageId: string, assistantMessageId: string): Promise<void> {
    await rm(this.captureClaimPath(sessionId, userMessageId, assistantMessageId), { force: true });
  }

  async markCaptured(sessionId: string, userMessageId: string, assistantMessageId: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.capturedPath(sessionId, userMessageId, assistantMessageId), "captured\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    await this.releaseCapture(sessionId, userMessageId, assistantMessageId);
  }

  async isCaptured(sessionId: string, userMessageId: string, assistantMessageId: string): Promise<boolean> {
    await this.cleanupExpiredState();
    return exists(this.capturedPath(sessionId, userMessageId, assistantMessageId));
  }

  async markSessionError(sessionId: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.errorPath(sessionId), "error\n", { encoding: "utf-8", mode: 0o600 });
  }

  async clearSessionError(sessionId: string): Promise<void> {
    await rm(this.errorPath(sessionId), { force: true });
  }

  async hasSessionError(sessionId: string): Promise<boolean> {
    await this.cleanupExpiredState();
    return exists(this.errorPath(sessionId));
  }

  async clearSession(sessionId: string): Promise<void> {
    const prefix = `${sessionHash(sessionId)}.`;
    const entries = await this.entries();
    await Promise.all(entries
      .filter((entry) => (
        entry.isFile()
        && entry.name.startsWith(prefix)
        && !entry.name.endsWith(".captured")
        && !entry.name.endsWith(".session-ended")
      ))
      .map((entry) => rm(path.join(this.stateDir, entry.name), { force: true })));
  }

  async cleanupExpiredState(): Promise<void> {
    const entries = await this.entries();
    const now = Date.now();
    await Promise.all(entries
      .filter((entry) => entry.isFile() && isStateFile(entry.name))
      .map(async (entry) => {
        const file = path.join(this.stateDir, entry.name);
        try {
          const metadata = await stat(file);
          if (entry.name.endsWith(".claim")) {
            if (metadata.mtimeMs < now - this.claimTtlMs && await this.isClaimStale(file)) {
              await rm(file, { force: true });
            }
          } else if (metadata.mtimeMs < now - this.stateTtlMs) {
            await rm(file, { force: true });
          }
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }));
  }

  private async claim(file: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(file, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, claimedAt: Date.now() }));
        } catch (error) {
          await rm(file, { force: true });
          throw error;
        } finally {
          await handle.close();
        }
        return true;
      } catch (error) {
        if (!isExistingFile(error)) throw error;
        if (attempt > 0 || !await this.isClaimStale(file)) return false;
        await rm(file, { force: true });
      }
    }
    return false;
  }

  private async isClaimStale(file: string): Promise<boolean> {
    try {
      const metadata = await stat(file);
      const claim = JSON.parse(await readFile(file, "utf-8")) as { pid?: unknown };
      if (typeof claim.pid === "number" && isProcessRunning(claim.pid)) return false;
      return metadata.mtimeMs < Date.now() - this.claimTtlMs;
    } catch (error) {
      return isMissingFile(error);
    }
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, content, { encoding: "utf-8", mode: 0o600 });
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  private async entries() {
    try {
      return await readdir(this.stateDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  private recallPath(sessionId: string, userMessageId: string): string {
    return path.join(this.stateDir, `${recordPrefix(sessionId, userMessageId)}.recall.json`);
  }

  private recallClaimPath(sessionId: string, userMessageId: string): string {
    return path.join(this.stateDir, `${recordPrefix(sessionId, userMessageId)}.recall.claim`);
  }

  private recallInjectedPath(sessionId: string, userMessageId: string): string {
    return path.join(this.stateDir, `${recordPrefix(sessionId, userMessageId)}.recall.injected`);
  }

  private captureClaimPath(sessionId: string, userMessageId: string, assistantMessageId: string): string {
    return path.join(this.stateDir, `${turnPrefix(sessionId, userMessageId, assistantMessageId)}.capture.claim`);
  }

  private capturedPath(sessionId: string, userMessageId: string, assistantMessageId: string): string {
    return path.join(this.stateDir, `${turnPrefix(sessionId, userMessageId, assistantMessageId)}.captured`);
  }

  private errorPath(sessionId: string): string {
    return path.join(this.stateDir, `${sessionHash(sessionId)}.session.error`);
  }
}

function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function recordPrefix(sessionId: string, recordId: string): string {
  return `${sessionHash(sessionId)}.${createHash("sha256").update(recordId).digest("hex")}`;
}

function turnPrefix(sessionId: string, userMessageId: string, assistantMessageId: string): string {
  return recordPrefix(sessionId, `${userMessageId}\0${assistantMessageId}`);
}

function isStateFile(name: string): boolean {
  return /^[a-f0-9]{64}(?:\.[a-f0-9]{64})?\.(?:recall\.json|recall\.claim|recall\.injected|active-recall\.json|capture\.claim|captured|session\.error|session-end\.claim|session-ended)(?:\.[0-9a-f-]{36}\.(?:tmp|consuming))?$/.test(name);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}