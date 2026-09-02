import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CursorConfig } from "../src/config.js";
import { appendPendingEvent } from "../src/pending.js";
import { runWorker, type ConversationClient, type WorkerOptions } from "../src/worker.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Cursor worker 全局锁", () => {
  // 两个 detached one-shot 必须共享一个 owner 区域, 避免重复投递.
  it("串行化并发 worker", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "cursor-worker-lock-v3-"));
    tempDirs.push(rootDir);
    const config: CursorConfig = {
      rootDir,
      captureTimeoutMs: 60_000,
      recallTimeoutMs: 2_000,
      executablePath: "/bin/cursor",
      transcriptsRoot: "/cursor/projects",
    };
    for (const event of [
      { event: "user" as const, text: "问题" },
      { event: "assistant" as const, text: "回答" },
      { event: "stop" as const, status: "completed" },
    ]) {
      await appendPendingEvent(rootDir, {
        v: 1,
        conversation_id: "c1",
        generation_id: "g1",
        at_ms: 1,
        ...event,
      });
    }

    let owner = false;
    let owners = 0;
    let maxOwners = 0;
    const waiters: Array<() => void> = [];
    const acquireLock: WorkerOptions["acquireLock"] = async () => {
      if (owner) await new Promise<void>((resolve) => waiters.push(resolve));
      owner = true;
      owners += 1;
      maxOwners = Math.max(maxOwners, owners);
      return () => {
        owners -= 1;
        owner = false;
        waiters.shift()?.();
      };
    };
    const client: ConversationClient = {
      addConversation: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {};
      }),
    };

    await Promise.all([
      runWorker({ config, client, acquireLock, log: vi.fn() }),
      runWorker({ config, client, acquireLock, log: vi.fn() }),
    ]);

    expect(maxOwners).toBe(1);
    expect(client.addConversation).toHaveBeenCalledOnce();
  });
});
