import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { WikiService } from "../src/store/wiki-service.js";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "okf-esm-smoke-"));
  const { db, raw } = createDb({ path: ":memory:" });

  try {
    const store = new SqliteKnowledgeStore(db);
    const worker = async () => ({ pageCount: 1 });
    const service = new WikiService({ store, dataRoot: join(root, "data"), worker });

    // Create a wiki
    const { row } = service.create({ service_id: "service-x", team_id: "team-x", name: "SmokeWiki" });

    // Import a bundle
    const files = [
      { path: "index.md", content: '---\nokf_version: "0.2"\n---\n# Index' }
    ];

    const report = service.okfImport("service-x", "team-x", row.wiki_id, files);
    if (!report) throw new Error("okfImport returned null");

    const updatedRow = store.getWikiById("service-x", row.wiki_id);
    if (!updatedRow) throw new Error("Wiki not found");
    if (updatedRow.version !== row.version + 1) throw new Error("Version not incremented");
    if (updatedRow.status !== "processing") throw new Error("Import advertised ready before indexing");

    const wikiDir = join(service.dirFor("service-x", "team-x", row.wiki_id), "wiki");
    if (!existsSync(join(wikiDir, "index.md"))) throw new Error("File not written to disk");
    const content = readFileSync(join(wikiDir, "index.md"), "utf-8");
    if (content !== files[0].content) throw new Error("File content mismatch");

    console.log("WikiService ESM Smoke Test Passed");
  } finally {
    raw.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(e => {
  console.error("ESM Smoke Test Failed:");
  console.error(e);
  process.exit(1);
});
