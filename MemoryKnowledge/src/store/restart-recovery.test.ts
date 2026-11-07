import { describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";

describe("restart recovery", () => {
  it.each([
    ["wiki", "processing"], ["wiki", "pending"],
    ["code graph", "processing"], ["code graph", "pending"],
  ] as const)("clears the interrupted %s phase from %s", (kind, status) => {
    const { db, raw } = createDb({ path: ":memory:" });
    const store = new SqliteKnowledgeStore(db);
    try {
      const wiki = store.createWiki({ service_id: "svc", team_id: "team", name: "wiki" }).row;
      const graph = store.createCodeGraph({
        service_id: "svc", team_id: "team", repo_url: "https://example.test/repo", branch: "main",
      }).row;
      const ready = store.createWiki({ service_id: "svc", team_id: "team", name: "ready" }).row;
      const failed = store.createWiki({ service_id: "svc", team_id: "team", name: "failed" }).row;
      store.updateWikiStatus("svc", wiki.wiki_id, { status, internal_status: "ingesting" });
      store.updateCodeGraphStatus("svc", graph.code_graph_id, { status, internal_status: "indexing" });
      store.updateWikiStatus("svc", ready.wiki_id, { status: "ready", page_count: 7 });
      store.updateWikiStatus("svc", failed.wiki_id, { status: "failed", sync_error: "existing failure" });

      expect(store.markInterruptedAsFailed()).toBe(2);
      const result = kind === "wiki"
        ? store.getWikiById("svc", wiki.wiki_id)
        : store.getCodeGraphById("svc", graph.code_graph_id);
      expect(result).toMatchObject({
        status: "failed", internal_status: null, sync_error: "interrupted by restart",
      });
      expect(store.getWikiById("svc", ready.wiki_id)).toMatchObject({ status: "ready", page_count: 7 });
      expect(store.getWikiById("svc", failed.wiki_id)).toMatchObject({ status: "failed", sync_error: "existing failure" });
    } finally {
      raw.close();
    }
  });
});
