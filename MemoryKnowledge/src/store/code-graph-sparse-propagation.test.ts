import { describe, expect, it } from "vitest";
import { BuildQueue, CodeGraphService } from "./index.js";
import type { CodeGraphRow, IKnowledgeStore } from "./types.js";

const baseRow = (): CodeGraphRow => ({
  code_graph_id: "cg-test",
  service_id: "svc",
  team_id: "team",
  repo_name: "repo",
  repo_url: "https://github.com/example/repo.git",
  branch: "main",
  sparse_paths: ["src", "docs/api"],
  commit_hash: null,
  owner_user_id: null,
  user_id: null,
  agent_id: null,
  task_id: null,
  visibility: "team",
  status: "pending",
  internal_status: null,
  sync_error: null,
  stats_json: null,
  service_url: null,
  summary: null,
  version: 0,
  last_sync_at: null,
  created_at: "now",
  updated_at: "now",
  deleted_at: null,
});

describe("CodeGraphService sparse path propagation", () => {
  it("passes persisted sparse paths to the build worker", async () => {
    const row = baseRow();
    const calls: string[][] = [];
    const store = {
      createCodeGraph: () => ({ row, existed: false }),
      getCodeGraphById: () => row,
      updateCodeGraphStatus: () => undefined,
      appendCodeGraphAudit: () => undefined,
    } as unknown as IKnowledgeStore;
    const queue = new BuildQueue();
    const service = new CodeGraphService({
      store,
      dataRoot: "/tmp/code-graphs",
      queue,
      worker: async (ctx) => {
        calls.push(ctx.sparsePaths);
        return { stats: { files: 0, nodes: 0, edges: 0 } };
      },
    });

    service.create({
      service_id: "svc",
      team_id: "team",
      repo_url: row.repo_url,
      branch: row.branch,
    });
    await queue.onIdle("cg-test");

    expect(calls).toEqual([["src", "docs/api"]]);
  });
});
