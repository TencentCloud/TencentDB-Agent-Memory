import { describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";

describe("code graph sparse paths", () => {
  it("round-trips sparse paths through the metadata store", () => {
    const { db } = createDb({ path: ":memory:" });
    const store = new SqliteKnowledgeStore(db);

    const created = store.createCodeGraph({
      service_id: "svc",
      team_id: "team",
      repo_url: "https://github.com/example/repo.git",
      branch: "main",
      sparse_paths: ["src", "docs/api"],
    });

    expect(created.row.sparse_paths).toEqual(["src", "docs/api"]);
    expect(store.getCodeGraphById("svc", created.row.code_graph_id)?.sparse_paths).toEqual([
      "src",
      "docs/api",
    ]);
  });

  it("returns an empty sparse path list for legacy rows without configuration", () => {
    const { db, raw } = createDb({ path: ":memory:" });
    raw.prepare(
      `INSERT INTO knowledge_code_graph
        (code_graph_id, service_id, team_id, repo_name, repo_url, branch, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("cg-legacy", "svc", "team", "", "https://github.com/example/repo.git", "main", "pending", "now", "now");

    const store = new SqliteKnowledgeStore(db);
    expect(store.getCodeGraphById("svc", "cg-legacy")?.sparse_paths).toEqual([]);
  });
});
