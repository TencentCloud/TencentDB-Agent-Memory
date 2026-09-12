import { TDAMError } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { createMemoryClient } from "./client.js";
import type { CursorConfig } from "./config.js";
import { foldPending, type FoldedCapture } from "./pending.js";

const INCOMPLETE_TTL_MS = 24 * 60 * 60 * 1_000;

interface LockOptions {
  realpath: false;
  stale: number;
  update: number;
  retries: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
  };
  onCompromised: (error: Error) => void;
}

type ReleaseLock = () => Promise<void> | void;

export interface ConversationClient {
  addConversation: (params: {
    session_id: string;
    messages: Array<{
      role: "user" | "assistant";
      content: string;
    }>;
  }) => Promise<unknown>;
}

export interface WorkerOptions {
  config: CursorConfig;
  client?: ConversationClient;
  createClient?: () => ConversationClient;
  acquireLock?: (
    target: string,
    options: LockOptions,
  ) => Promise<ReleaseLock>;
  remove?: (filePath: string) => Promise<void>;
  log: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

interface PendingFile {
  path: string;
  capture?: FoldedCapture;
  mtimeMs: number;
}

async function listPending(rootDir: string): Promise<PendingFile[]> {
  const dir = path.join(rootDir, "pending");
  let names: string[];
  try {
    names = (await readdir(dir))
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }

  const result: PendingFile[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const [content, info] = await Promise.all([
        readFile(filePath, "utf8"),
        stat(filePath),
      ]);
      result.push({
        path: filePath,
        capture: foldPending(content),
        mtimeMs: info.mtimeMs,
      });
    } catch {
      // Hook 可能仍在创建文件, 下一次扫描会重试.
    }
  }
  return result;
}

function localError(error: unknown): { error: string } {
  return {
    error: error instanceof Error
      ? error.message.slice(0, 300)
      : String(error).slice(0, 300),
  };
}

function sdkError(error: unknown): Record<string, unknown> {
  if (error instanceof TDAMError) {
    return { error_name: error.name, code: error.code };
  }
  return {
    error_name: error instanceof Error ? error.name : typeof error,
  };
}

function isDiscardable(error: unknown): error is TDAMError {
  return error instanceof TDAMError && (error.code === 400 || error.code === 413);
}

export async function runWorker(options: WorkerOptions): Promise<void> {
  const { config } = options;
  const now = options.now ?? Date.now;
  const remove = options.remove ?? unlink;
  const acquireLock =
    options.acquireLock ??
    ((target: string, lockOptions: LockOptions) =>
      lockfile.lock(target, lockOptions));

  await mkdir(config.rootDir, { recursive: true, mode: 0o700 });
  let compromised = false;
  let release: ReleaseLock;
  try {
    release = await acquireLock(config.rootDir, {
      realpath: false,
      stale: 180_000,
      update: 10_000,
      retries: {
        retries: 120,
        factor: 1,
        minTimeout: 1_000,
        maxTimeout: 1_000,
      },
      onCompromised: (error) => {
        compromised = true;
        options.log("lock_compromised", {
          error: error.message.slice(0, 300),
        });
      },
    });
  } catch (error) {
    options.log("lock_acquire_failed", localError(error));
    return;
  }

  try {
    const initial = await listPending(config.rootDir);
    for (const pending of initial) {
      if (!pending.capture && now() - pending.mtimeMs > INCOMPLETE_TTL_MS) {
        try {
          await remove(pending.path);
          options.log("incomplete_expired", {
            pending: path.basename(pending.path, ".jsonl"),
          });
        } catch (error) {
          options.log("pending_delete_failed", {
            pending: path.basename(pending.path, ".jsonl"),
            ...localError(error),
          });
        }
      }
    }

    if (compromised || !initial.some((item) => item.capture)) return;

    let client: ConversationClient;
    try {
      client = options.client ??
        (options.createClient ?? (() =>
          createMemoryClient(config, config.captureTimeoutMs)))();
    } catch (error) {
      options.log("capture_retained", sdkError(error));
      return;
    }

    let retained = false;
    while (!compromised && !retained) {
      // 锁内持续扫描到安静, 接住 owner 工作期间新写完的 pending.
      const complete = (await listPending(config.rootDir))
        .filter((pending) => pending.capture);
      if (complete.length === 0) break;

      for (const pending of complete) {
        if (compromised || !pending.capture) return;
        const pendingName = path.basename(pending.path, ".jsonl");
        let outcome: "capture_acked" | "capture_discarded";
        let discardCode: number | undefined;
        try {
          await client.addConversation({
            session_id: `cursor:${pending.capture.conversationId}`,
            messages: [
              { role: "user", content: pending.capture.userContent },
              { role: "assistant", content: pending.capture.assistantContent },
            ],
          });
          outcome = "capture_acked";
        } catch (error) {
          if (!isDiscardable(error)) {
            options.log("capture_retained", {
              pending: pendingName,
              ...sdkError(error),
            });
            retained = true;
            break;
          }
          outcome = "capture_discarded";
          discardCode = error.code;
        }

        if (compromised) return;
        try {
          await remove(pending.path);
        } catch (error) {
          options.log("pending_delete_failed", {
            pending: pendingName,
            ...localError(error),
          });
          retained = true;
          break;
        }
        options.log(outcome, {
          pending: pendingName,
          ...(discardCode === undefined ? {} : { code: discardCode }),
        });
      }
    }
  } finally {
    try {
      await release();
    } catch (error) {
      options.log("lock_release_error", localError(error));
    }
  }
}
