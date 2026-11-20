import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoSyncScheduler } from "./auto-sync-scheduler.js";
import { CodeGraphService } from "./code-graph-service.js";
import type { CodeGraphRow, IKnowledgeStore } from "./types.js";

describe("AutoSyncScheduler build concurrency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([1, 2, 3])("holds each of %i slots until the actual build finishes", async (limit) => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      service_id: "test-service", team_id: "test-team", code_graph_id: `graph-${i}`,
      repo_url: `https://example.invalid/repo-${i}.git`, branch: "main",
      status: "ready", internal_status: null, version: 1,
    } as CodeGraphRow));
    const byId = new Map(rows.map((row) => [row.code_graph_id, row]));
    const store = {
      listSyncedCodeGraphs: () => rows.filter((row) => row.status === "ready"),
      getCodeGraph: (_service: string, _team: string, id: string) => byId.get(id) ?? null,
      getCodeGraphById: (_service: string, id: string) => byId.get(id) ?? null,
      updateCodeGraphStatus: (_service: string, id: string, patch: Partial<CodeGraphRow>) => {
        Object.assign(byId.get(id)!, patch);
      },
      appendCodeGraphAudit: () => {},
    } as unknown as IKnowledgeStore;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    let started = 0;
    const service = new CodeGraphService({
      store, dataRoot: "/unused-test-root",
      worker: async () => {
        started++;
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        return {};
      },
    });
    const scheduler = new AutoSyncScheduler({
      store, cgService: service,
      config: { enabled: true, scanIntervalMs: 600_000, maxConcurrentSyncs: limit },
    });
    scheduler.start();
    scheduler.triggerScan();
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(started).toBe(limit);
      expect(active).toBe(limit);
      expect(scheduler.getStatus()).toMatchObject({ activeSyncs: limit, queueLength: rows.length - limit });
      release();
      await vi.advanceTimersByTimeAsync(100);
      await service.onIdle();
      expect(started).toBe(rows.length);
      expect(peak).toBeLessThanOrEqual(limit);
      expect(scheduler.getStatus()).toMatchObject({ activeSyncs: 0, queueLength: 0 });
      expect(rows.every((row) => row.status === "ready")).toBe(true);
    } finally {
      release();
      scheduler.stop();
      await service.onIdle();
    }
  });
});
