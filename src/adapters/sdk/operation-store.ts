import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterOperationStore } from "./types.js";

export interface FileAdapterOperationStoreOptions {
  stateDir: string;
  claimTtlMs?: number;
}

const DEFAULT_CLAIM_TTL_MS = 60_000;

export class ExternalAdapterOperationStore implements AdapterOperationStore {
  async claim(): Promise<boolean> {
    return true;
  }

  async complete(): Promise<void> {}

  async release(): Promise<void> {}
}

export class FileAdapterOperationStore implements AdapterOperationStore {
  private readonly claimTtlMs: number;

  constructor(private readonly options: FileAdapterOperationStoreOptions) {
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  }

  async claim(key: string): Promise<boolean> {
    await mkdir(this.options.stateDir, { recursive: true });
    if (await exists(this.completedPath(key))) return false;

    const claimPath = this.claimPath(key);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(claimPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, claimedAt: Date.now() }));
        await handle.close();
        if (await exists(this.completedPath(key))) {
          await rm(claimPath, { force: true });
          return false;
        }
        return true;
      } catch (error) {
        if (!isExistingFile(error)) throw error;
        if (attempt > 0 || !await this.isClaimStale(claimPath)) return false;
        await rm(claimPath, { force: true });
      }
    }
    return false;
  }

  async complete(key: string): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true });
    const target = this.completedPath(key);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, "completed\n", { encoding: "utf-8", mode: 0o600 });
    await rename(temp, target);
    await rm(this.claimPath(key), { force: true });
  }

  async release(key: string): Promise<void> {
    await rm(this.claimPath(key), { force: true });
  }

  private claimPath(key: string): string {
    return path.join(this.options.stateDir, `${keyHash(key)}.claim`);
  }

  private completedPath(key: string): string {
    return path.join(this.options.stateDir, `${keyHash(key)}.completed`);
  }

  private async isClaimStale(claimPath: string): Promise<boolean> {
    try {
      const metadata = await stat(claimPath);
      const claim = JSON.parse(await readFile(claimPath, "utf-8")) as { pid?: unknown };
      if (typeof claim.pid === "number" && isProcessRunning(claim.pid)) return false;
      return metadata.mtimeMs < Date.now() - this.claimTtlMs;
    } catch (error) {
      if (isMissingFile(error)) return true;
      return false;
    }
  }
}

export function defaultAdapterOperationStateDir(platform: string): string {
  const root = process.env.MEMORY_TENCENTDB_ROOT
    ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".memory-tencentdb");
  return path.join(root, "adapter-sdk", platform);
}

function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
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