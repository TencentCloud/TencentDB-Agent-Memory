import { describe, expect, it } from "vitest";

import type { HookCacheEntry, HookCacheRepo } from "../../db/hookCacheRepo.js";
import type { ContextBlock, PrewarmInput } from "../types.js";
import { prewarmAll } from "../prewarm.js";
import { HookRegistryImpl } from "../registry.js";

class RecordingRepo implements HookCacheRepo {
  preservedPrefixes: readonly string[] | undefined;

  put(): void {}
  putMany(): void {}
  async putIfAbsent(): Promise<boolean> { return true; }
  async get(): Promise<ContextBlock[] | null> { return null; }
  async getAllForSession(): Promise<HookCacheEntry[]> { return []; }
  clearBySession(
    _spaceId: string,
    _userId: string,
    _agentSource: string,
    _sessionId: string,
    preserveHookPrefixes?: readonly string[],
  ): void {
    this.preservedPrefixes = preserveHookPrefixes;
  }
}

describe("prewarmAll", () => {
  it("preserves immutable Skill queue snapshots during a refresh", async () => {
    const repo = new RecordingRepo();
    const registry = new HookRegistryImpl();
    registry.register({
      id: "cached-hook",
      description: "test hook",
      point: "system.suffix",
      priority: 1,
      cacheStrategy: "session_init",
      execute: async () => [],
      prewarm: async () => [],
    });
    const input = {
      userId: "user",
      agentSource: "codex",
      sessionInfo: { session_id: "session" },
    } as PrewarmInput;

    await prewarmAll(registry, repo, input, { clearBefore: true });

    expect(repo.preservedPrefixes).toEqual(["skill-queue-history-v1-"]);
  });
});
