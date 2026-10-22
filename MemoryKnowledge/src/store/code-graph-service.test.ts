import { describe, expect, it, vi } from "vitest";

import {
  CodeGraphService,
  DEFAULT_CODE_GRAPH_BUILD_TIMEOUT_MS,
  resolveCodeGraphBuildTimeoutMs,
  type CodeGraphWorker,
} from "./code-graph-service.js";
import type { CodeGraphRow, CodeGraphStatusPatch, IKnowledgeStore } from "./types.js";

const SERVICE_ID = "svc-test";
const TEAM_ID = "team-test";
const CODE_GRAPH_ID = "cg-test";

function createRow(): CodeGraphRow {
  const now = new Date().toISOString();
  return {
    code_graph_id: CODE_GRAPH_ID,
    service_id: SERVICE_ID,
    team_id: TEAM_ID,
    repo_name: "test-repo",
    repo_url: "https://example.com/test/repo.git",
    branch: "main",
    commit_hash: null,
    owner_user_id: null,
    user_id: "user-test",
    agent_id: null,
    task_id: null,
    visibility: "team",
    status: "ready",
    internal_status: null,
    sync_error: null,
    stats_json: null,
    service_url: null,
    summary: null,
    version: 1,
    last_sync_at: now,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

function createStore() {
  let row = createRow();
  const audits: Array<{ action: string; detail: string | null }> = [];

  const store = {
    getCodeGraph: vi.fn(() => ({ ...row })),
    getCodeGraphById: vi.fn(() => ({ ...row })),
    updateCodeGraphStatus: vi.fn(
      (_serviceId: string, _id: string, patch: CodeGraphStatusPatch) => {
        row = {
          ...row,
          ...patch,
          updated_at: new Date().toISOString(),
        };
      },
    ),
    appendCodeGraphAudit: vi.fn(
      (entry: { action: string; detail: string | null }) => {
        audits.push({ action: entry.action, detail: entry.detail });
      },
    ),
  };

  return {
    store: store as unknown as IKnowledgeStore,
    getRow: () => ({ ...row }),
    audits,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 250): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("CodeGraphService build deadline", () => {
  it("marks a never-settling worker as failed and releases the queue", async () => {
    const { store, getRow } = createStore();
    let signal: AbortSignal | undefined;
    const releaseInstance = vi.fn();
    const worker: CodeGraphWorker = (ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    };
    const service = new CodeGraphService({
      store,
      dataRoot: "D:/tmp/code-graph-service-test",
      worker,
      buildTimeoutMs: 25,
      releaseInstance,
    });

    expect(service.sync(SERVICE_ID, TEAM_ID, CODE_GRAPH_ID).kind).toBe("ok");
    await waitFor(() => getRow().status === "processing");

    await Promise.race([
      service.onIdle(CODE_GRAPH_ID),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("build did not time out")), 1_500),
      ),
    ]);

    expect(getRow().status).toBe("failed");
    expect(getRow().internal_status).toBeNull();
    expect(getRow().sync_error).toContain("timed out");
    expect(signal?.aborted).toBe(true);
    expect(releaseInstance).toHaveBeenCalledWith(CODE_GRAPH_ID);
  });

  it("keeps the terminal failed state when a timed-out worker settles later", async () => {
    const { store, getRow } = createStore();
    let lateProgressCalled = false;
    const worker: CodeGraphWorker = async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      lateProgressCalled = true;
      ctx.setInternalStatus("late-progress");
      return {};
    };
    const service = new CodeGraphService({
      store,
      dataRoot: "D:/tmp/code-graph-service-test",
      worker,
      buildTimeoutMs: 20,
    });

    expect(service.sync(SERVICE_ID, TEAM_ID, CODE_GRAPH_ID).kind).toBe("ok");
    await service.onIdle(CODE_GRAPH_ID);
    await waitFor(() => lateProgressCalled, 1_000);

    expect(getRow().status).toBe("failed");
    expect(getRow().sync_error).toContain("timed out");
  });

  it("still promotes a worker that settles before the deadline", async () => {
    const { store, getRow } = createStore();
    const worker: CodeGraphWorker = async () => ({
      commitHash: "abc123",
      stats: { files: 1, nodes: 2, edges: 3 },
    });
    const service = new CodeGraphService({
      store,
      dataRoot: "D:/tmp/code-graph-service-test",
      worker,
      buildTimeoutMs: 250,
    });

    expect(service.sync(SERVICE_ID, TEAM_ID, CODE_GRAPH_ID).kind).toBe("ok");
    await service.onIdle(CODE_GRAPH_ID);

    expect(getRow().status).toBe("ready");
    expect(getRow().commit_hash).toBe("abc123");
    expect(getRow().sync_error).toBeNull();
  });
});

describe("resolveCodeGraphBuildTimeoutMs", () => {
  it("uses a 30 minute default", () => {
    expect(resolveCodeGraphBuildTimeoutMs({})).toBe(DEFAULT_CODE_GRAPH_BUILD_TIMEOUT_MS);
  });

  it("supports disabling the deadline with zero", () => {
    expect(
      resolveCodeGraphBuildTimeoutMs({ KNOWLEDGE_CODEGRAPH_BUILD_TIMEOUT_MIN: "0" }),
    ).toBe(0);
  });

  it("falls back for invalid values and caps excessive values", () => {
    expect(
      resolveCodeGraphBuildTimeoutMs({ KNOWLEDGE_CODEGRAPH_BUILD_TIMEOUT_MIN: "NaN" }),
    ).toBe(DEFAULT_CODE_GRAPH_BUILD_TIMEOUT_MS);
    expect(
      resolveCodeGraphBuildTimeoutMs({ KNOWLEDGE_CODEGRAPH_BUILD_TIMEOUT_MIN: "99999" }),
    ).toBe(24 * 60 * 60_000);
  });
});
