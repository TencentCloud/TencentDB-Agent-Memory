import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoSyncScheduler } from "./auto-sync-scheduler.js";
import type { CodeGraphService } from "./code-graph-service.js";
import type { CodeGraphRow, IKnowledgeStore } from "./types.js";

describe("AutoSyncScheduler unchanged scans", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("probes twice without calling the forceful sync path or enqueueing builds", async () => {
    const row = {
      service_id: "svc-1", team_id: "team-1", code_graph_id: "cg-1",
      repo_url: "https://example.invalid/repo.git", branch: "main",
      status: "ready", internal_status: null, version: 1, has_last_good: true,
    } as CodeGraphRow;
    const store = {
      listSyncedCodeGraphs: () => [{ code_graph_id: row.code_graph_id, service_id: row.service_id, team_id: row.team_id }],
      getCodeGraph: () => row,
    } as unknown as IKnowledgeStore;
    const syncIfChanged = vi.fn().mockResolvedValue({ kind: "unchanged", revision: "a".repeat(40) });
    const sync = vi.fn();
    const service = { syncIfChanged, sync, onIdle: vi.fn() } as unknown as CodeGraphService;
    const scheduler = new AutoSyncScheduler({
      store, cgService: service,
      config: { enabled: true, scanIntervalMs: 600_000, maxConcurrentSyncs: 1 },
    });

    scheduler.start();
    try {
      scheduler.triggerScan();
      await vi.advanceTimersByTimeAsync(200);
      scheduler.triggerScan();
      await vi.advanceTimersByTimeAsync(200);

      expect(syncIfChanged).toHaveBeenCalledTimes(2);
      expect(sync).not.toHaveBeenCalled();
      expect(service.onIdle).not.toHaveBeenCalled();
      expect(scheduler.getStatus()).toMatchObject({ activeSyncs: 0, queueLength: 0 });
    } finally {
      scheduler.stop();
    }
  });
});