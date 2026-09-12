/**
 * State shared between hook processes.
 *
 * Every Claude Code hook is a separate process, so the prompt cached at
 * UserPromptSubmit, the capture markers and the transcript position live in
 * small files under one directory. Names are hashes of the session id (and
 * prompt id), so nothing sensitive appears in file names.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PromptRecord {
  sessionId: string;
  promptId: string;
  prompt: string;
}

export interface PluginStateOptions {
  /** Prompt cache and capture markers expire after this. */
  stateTtlMs?: number;
  /** A capture claim left by a killed hook is reclaimable after this. */
  claimTtlMs?: number;
  /** Session-level markers (transcript position, persona sent) expire after this. */
  sessionTtlMs?: number;
}

const DEFAULT_STATE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CLAIM_TTL_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export class PluginState {
  private readonly stateTtlMs: number;
  private readonly claimTtlMs: number;
  private readonly sessionTtlMs: number;

  constructor(private readonly stateDir: string, options: PluginStateOptions = {}) {
    this.stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  // ── prompt cache ──────────────────────────────────────────────────────

  async savePrompt(sessionId: string, promptId: string, prompt: string): Promise<void> {
    await this.cleanupExpiredState();
    await this.writeAtomic(this.promptPath(sessionId, promptId), JSON.stringify({ sessionId, promptId, prompt } satisfies PromptRecord));
  }

  /** For hosts that do not supply `prompt_id`: remember the newest prompt of the session. */
  async saveLatestPrompt(sessionId: string, prompt: string): Promise<string> {
    const promptId = `fallback:${randomUUID()}`;
    await this.savePrompt(sessionId, promptId, prompt);
    await this.writeAtomic(this.sessionPath(sessionId, "latest-prompt.json"), JSON.stringify({ promptId }));
    return promptId;
  }

  async getPromptRecord(sessionId: string, promptId: string): Promise<PromptRecord | undefined> {
    const raw = await readOptional(this.promptPath(sessionId, promptId));
    if (!raw) return undefined;
    const record = JSON.parse(raw) as Partial<PromptRecord>;
    return typeof record.prompt === "string" ? { sessionId, promptId, prompt: record.prompt } : undefined;
  }

  async getLatestPromptRecord(sessionId: string): Promise<PromptRecord | undefined> {
    const raw = await readOptional(this.sessionPath(sessionId, "latest-prompt.json"));
    if (!raw) return undefined;
    const record = JSON.parse(raw) as { promptId?: unknown };
    return typeof record.promptId === "string" ? this.getPromptRecord(sessionId, record.promptId) : undefined;
  }

  // ── per-turn capture markers ──────────────────────────────────────────

  async isCaptured(sessionId: string, promptId: string): Promise<boolean> {
    return exists(this.capturedPath(sessionId, promptId));
  }

  /** Claim a turn so two Stop processes never capture it twice. */
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

  // ── session-level markers ─────────────────────────────────────────────

  /** Last transcript entry uuid sent to the Gateway. */
  async getTranscriptMarker(sessionId: string): Promise<string | undefined> {
    const raw = await readOptional(this.sessionPath(sessionId, "transcript-marker.json"));
    if (!raw) return undefined;
    const marker = JSON.parse(raw) as { lastUuid?: unknown };
    return typeof marker.lastUuid === "string" && marker.lastUuid ? marker.lastUuid : undefined;
  }

  async setTranscriptMarker(sessionId: string, lastUuid: string): Promise<void> {
    await this.writeAtomic(this.sessionPath(sessionId, "transcript-marker.json"), JSON.stringify({ lastUuid, updatedAt: Date.now() }));
  }

  /** A named once-per-session flag, for example "persona-sent". */
  async hasSessionFlag(sessionId: string, name: string): Promise<boolean> {
    return exists(this.sessionPath(sessionId, `${name}.flag`));
  }

  async setSessionFlag(sessionId: string, name: string): Promise<void> {
    await this.writeAtomic(this.sessionPath(sessionId, `${name}.flag`), JSON.stringify({ setAt: Date.now() }));
  }

  // ── housekeeping ──────────────────────────────────────────────────────

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
        let metadata;
        try {
          metadata = await stat(file);
        } catch (error) {
          if (isMissingFile(error)) return;
          throw error;
        }
        if (entry.name.endsWith(".capture.claim")) {
          if (metadata.mtimeMs < now - this.claimTtlMs && await this.isClaimStale(file)) await rm(file, { force: true });
        } else if (entry.name.endsWith(".transcript-marker.json") || entry.name.endsWith(".flag")) {
          if (metadata.mtimeMs < now - this.sessionTtlMs) await rm(file, { force: true });
        } else if (metadata.mtimeMs < now - this.stateTtlMs) {
          await rm(file, { force: true });
        }
      }));
  }

  private async writeAtomic(target: string, content: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, content, { encoding: "utf-8", mode: 0o600 });
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  private promptPath(sessionId: string, promptId: string): string {
    return path.join(this.stateDir, `${hash(`${sessionId}\0${promptId}`)}.prompt.json`);
  }

  private claimPath(sessionId: string, promptId: string): string {
    return path.join(this.stateDir, `${hash(`${sessionId}\0${promptId}`)}.capture.claim`);
  }

  private capturedPath(sessionId: string, promptId: string): string {
    return path.join(this.stateDir, `${hash(`${sessionId}\0${promptId}`)}.captured`);
  }

  private sessionPath(sessionId: string, suffix: string): string {
    return path.join(this.stateDir, `${hash(sessionId)}.${suffix}`);
  }

  private async isClaimStale(claimPath: string): Promise<boolean> {
    try {
      const metadata = await stat(claimPath);
      const claim = JSON.parse(await readFile(claimPath, "utf-8")) as { pid?: unknown };
      if (typeof claim.pid === "number" && isProcessRunning(claim.pid)) return false;
      return metadata.mtimeMs < Date.now() - this.claimTtlMs;
    } catch (error) {
      return isMissingFile(error);
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
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

function isStateFile(name: string): boolean {
  return /^[a-f0-9]{64}\.(?:prompt\.json|latest-prompt\.json|capture\.claim|captured|transcript-marker\.json|[a-z-]+\.flag)(?:\.[0-9a-f-]{36}\.tmp)?$/.test(name);
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
