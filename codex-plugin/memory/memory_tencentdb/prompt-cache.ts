import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PromptCacheOptions {
  dir?: string;
  maxAgeMs?: number;
}

interface PromptRecord {
  prompt: string;
}

function cacheDir(opts: PromptCacheOptions): string {
  return opts.dir ?? process.env.TDAI_CODEX_CACHE_DIR ??
    path.join(os.homedir(), ".memory-tencentdb", "prompts", "codex");
}

export function getPromptCachePath(
  sessionId: string,
  opts: PromptCacheOptions = {},
): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return path.join(cacheDir(opts), `${key}.json`);
}

export async function writePrompt(
  sessionId: string,
  prompt: string,
  opts: PromptCacheOptions = {},
): Promise<void> {
  const target = getPromptCachePath(sessionId, opts);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify({ prompt } satisfies PromptRecord), "utf8");
  try {
    await rename(temporary, target);
  } catch {
    await rm(target, { force: true });
    await rename(temporary, target);
  }
}

export async function readPrompt(
  sessionId: string,
  opts: PromptCacheOptions = {},
): Promise<string | null> {
  const target = getPromptCachePath(sessionId, opts);
  try {
    const info = await stat(target);
    if (Date.now() - info.mtimeMs > (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
      await rm(target, { force: true });
      return null;
    }

    const record = JSON.parse(await readFile(target, "utf8")) as Partial<PromptRecord>;
    return typeof record.prompt === "string" && record.prompt.trim() ? record.prompt : null;
  } catch {
    return null;
  }
}

export async function deletePrompt(
  sessionId: string,
  opts: PromptCacheOptions = {},
): Promise<void> {
  await rm(getPromptCachePath(sessionId, opts), { force: true });
}
