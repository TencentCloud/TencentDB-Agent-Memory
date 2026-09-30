import { describe, expect, it } from "vitest";

import { MemoryStorage } from "../../storage/memory-storage.js";
import { KvHookCacheRepo } from "../kv-hook-cache-repo.js";

const identity = ["space", "user", "codex", "session"] as const;

describe("KvHookCacheRepo", () => {
  it("keeps the first value written with putIfAbsent", async () => {
    const repo = new KvHookCacheRepo(new MemoryStorage());
    const first = [{ type: "custom" as const, content: "first" }];
    const second = [{ type: "custom" as const, content: "second" }];

    await expect(repo.putIfAbsent(...identity, "snapshot", first)).resolves.toBe(true);
    await expect(repo.putIfAbsent(...identity, "snapshot", second)).resolves.toBe(false);
    await expect(repo.get(...identity, "snapshot")).resolves.toEqual(first);
  });

  it("clears ordinary hooks while preserving Skill queue snapshots", async () => {
    const repo = new KvHookCacheRepo(new MemoryStorage());
    await repo.put(...identity, "skill-injector", [{ type: "text", content: "old" }]);
    await repo.put(
      ...identity,
      "skill-queue-history-v1-queue-1",
      [{ type: "custom", content: "snapshot" }],
    );

    await repo.clearBySession(...identity, ["skill-queue-history-v1-"]);

    await expect(repo.get(...identity, "skill-injector")).resolves.toBeNull();
    await expect(repo.get(...identity, "skill-queue-history-v1-queue-1"))
      .resolves.toEqual([{ type: "custom", content: "snapshot" }]);
  });
});
