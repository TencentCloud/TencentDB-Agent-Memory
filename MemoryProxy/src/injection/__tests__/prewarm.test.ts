import { afterEach, describe, expect, it, vi } from "vitest";

import type { HookCacheRepo } from "../../db/hookCacheRepo.js";
import { prewarmAll } from "../prewarm.js";
import { HookRegistryImpl } from "../registry.js";
import type { PrewarmInput } from "../types.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("prewarmAll", () => {
  it("clears the global deadline timer after hooks finish", async () => {
    vi.useFakeTimers();
    const registry = new HookRegistryImpl();
    registry.register({
      id: "fast-hook",
      point: "system.prefix",
      priority: 0,
      description: "resolves immediately",
      cacheStrategy: "session_init",
      prewarm: async () => [{ type: "text", content: "cached" }],
      execute: async () => [],
    });
    const repo: HookCacheRepo = {
      put: vi.fn(),
      putMany: vi.fn(),
      get: vi.fn(async () => null),
      getAllForSession: vi.fn(async () => []),
      clearBySession: vi.fn(),
    };
    const input: PrewarmInput = {
      keyId: "key-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionInfo: { session_id: "session-1" } as PrewarmInput["sessionInfo"],
      agentDetail: null,
      taskDetail: null,
    };

    await expect(
      prewarmAll(registry, repo, input, { totalTimeoutMs: 1_000 }),
    ).resolves.toMatchObject({ cachedHookIds: ["fast-hook"], skipped: [] });
    expect(vi.getTimerCount()).toBe(0);
  });
});
