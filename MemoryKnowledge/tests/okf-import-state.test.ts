import { afterEach, describe, expect, it, vi } from "vitest";

const { failRename, failStageRename } = vi.hoisted(() => ({
  failRename: { value: false },
  failStageRename: { value: false }
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: vi.fn((oldPath: import("node:fs").PathLike, newPath: import("node:fs").PathLike) => {
      const oldPathStr = oldPath.toString();
      if (failRename.value && (oldPathStr.includes(".okf-stage-") || oldPathStr.includes(".okf-backup-"))) {
        throw new Error("Simulated filesystem error with secret path details: /secret/tenant/path");
      }
      if (failStageRename.value && oldPathStr.includes(".okf-stage-")) {
        throw new Error("Simulated stage-rename failure");
      }
      return actual.renameSync(oldPath, newPath);
    })
  };
});

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { WikiService } from "../src/store/wiki-service.js";
import { BundleRollbackError } from "../src/engines/wiki/okf-bundle.js";

const created: Array<{ root: string; raw: ReturnType<typeof createDb>["raw"] }> = [];
afterEach(() => {
  for (const { root, raw } of created.splice(0)) {
    raw.close();
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  failRename.value = false;
  failStageRename.value = false;
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "okf-import-state-"));
  const { db, raw } = createDb({ path: ":memory:" });
  created.push({ root, raw });
  const store = new SqliteKnowledgeStore(db);
  const worker = vi.fn(async () => ({}));
  const service = new WikiService({ store, dataRoot: join(root, "data"), worker });
  const row = service.create({ service_id: "service-a", team_id: "team-a", name: "Knowledge" }).row;
  return { service, store, worker, row, root };
}

const fixture = () => [
  { path: "index.md", content: "---\nokf_version: \"0.2\"\n---\n# Index", encoding: "utf-8" as const },
  { path: "nested/a.md", content: "---\ntype: CustomType\n---\n\n Alpha", encoding: "utf-8" as const },
];

describe("WikiService okfImport state transitions", () => {
  it("an unresolved journal blocks writes and replacement ingestion without changing state", async () => {
    const { service, row, store } = setup();
    const dir = service.dirFor("service-a", "team-a", row.wiki_id);
    writeFileSync(join(dir, "okf-journal.json"), "synthetic-unresolved-journal");
    store.updateWikiStatus("service-a", row.wiki_id, { status: "processing", internal_status: "indexing" });
    const before = store.getWikiById("service-a", row.wiki_id);
    expect(service.ingest("service-a", "team-a", row.wiki_id, undefined, { onBusy: "replace" })).toEqual({ kind: "recovery_required" });
    expect(store.getWikiById("service-a", row.wiki_id)).toEqual(before);
    expect(service.rawWrite("service-a", "team-a", row.wiki_id, "new.md", "synthetic")).toBe("processing");
    expect(service.rawWriteMany("service-a", "team-a", row.wiki_id, [{ filename: "new.md", content: "synthetic" }])).toBe("processing");
    expect(service.pageWrite("service-a", "team-a", row.wiki_id, "new.md", "synthetic")).toBe("processing");
    expect(await service.pageRm("service-a", "team-a", row.wiki_id, ["new.md"])).toBe("processing");
    expect(service.delete("service-a", "team-a", row.wiki_id)).toBe(false);
    expect(store.getWikiById("service-a", row.wiki_id)).toEqual(before);
    expect(readFileSync(join(dir, "okf-journal.json"), "utf8")).toBe("synthetic-unresolved-journal");
  });

  it("successful native import", () => {
    const { service, row, store } = setup();
    service.okfIndexed("service-a", "team-a", row.wiki_id, 4);
    service.okfImport("service-a", "team-a", row.wiki_id, fixture());

    const fresh = store.getWikiById("service-a", row.wiki_id)!;
    expect(fresh.version).toBe(row.version + 1);
    expect(fresh.status).toBe("processing");
  });

  it("failed postcommit version update preserves NEW exact file bytes and marks failed", () => {
    const { service, row, store } = setup();
    service.okfIndexed("service-a", "team-a", row.wiki_id, 4);
    service.okfImport("service-a", "team-a", row.wiki_id, fixture());
    service.okfIndexed("service-a", "team-a", row.wiki_id, 4);

    const newFixture = fixture();
    newFixture[1].content = "---\ntype: CustomType\n---\n\n NEW EXACT BYTES";

    const originalUpdate = store.updateWikiStatus.bind(store);
    vi.spyOn(store, "updateWikiStatus").mockImplementation((sId, wId, patch) => {
      if (patch.version) {
        throw new Error("Simulated DB version update failure");
      }
      return originalUpdate(sId, wId, patch);
    });

    expect(() => service.okfImport("service-a", "team-a", row.wiki_id, newFixture, true)).toThrowError("Simulated DB version update failure");

    const fresh = store.getWikiById("service-a", row.wiki_id)!;
    expect(fresh.status).toBe("failed");
    expect(fresh.sync_error).toBe("Post-commit metadata update failed");

    const content = readFileSync(join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki/nested/a.md"), "utf-8");
    expect(content).toBe("---\ntype: CustomType\n---\n\n NEW EXACT BYTES");
  });

  it("another DB failure during failure-status update preserves original thrown object and never sets ready", () => {
    const { service, row, store } = setup();
    service.okfIndexed("service-a", "team-a", row.wiki_id, 4);
    const originalUpdate = store.updateWikiStatus.bind(store);

    const originalError = new Error("Simulated DB version update failure");
    vi.spyOn(store, "updateWikiStatus").mockImplementation((sId, wId, patch) => {
      if (patch.version) {
        throw originalError;
      }
      if (patch.status === "failed") {
        throw new Error("Simulated DB secondary failure");
      }
      return originalUpdate(sId, wId, patch);
    });

    let caughtError: any;
    try {
      service.okfImport("service-a", "team-a", row.wiki_id, fixture());
    } catch(e) {
      caughtError = e;
    }

    expect(caughtError).toBe(originalError);

    const fresh = store.getWikiById("service-a", row.wiki_id)!;
    expect(fresh.status).toBe("processing");
  });

  it("validation/precommit failure restores prior ready and preserves OLD bytes", () => {
    const { service, row, store } = setup();
    service.okfIndexed("service-a", "team-a", row.wiki_id, 4);
    service.okfImport("service-a", "team-a", row.wiki_id, fixture());
    service.okfIndexed("service-a", "team-a", row.wiki_id, 4);

    const invalidFixture = [
      { path: "index.md", content: "dup" },
      { path: "index.md", content: "dup2" },
    ];

    expect(() => service.okfImport("service-a", "team-a", row.wiki_id, invalidFixture, true)).toThrowError("Duplicate bundle path");

    const fresh = store.getWikiById("service-a", row.wiki_id)!;
    expect(fresh.status).toBe("ready");

    const content = readFileSync(join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki/index.md"), "utf-8");
    expect(content).toBe(fixture()[0].content);
  });

  it("stage-rename failure with successful rollback restores prior status and preserves OLD bytes", () => {
    const { service, row, store } = setup();
    service.okfIndexed("service-a", "team-a", row.wiki_id, 4);
    service.okfImport("service-a", "team-a", row.wiki_id, fixture());
    service.okfIndexed("service-a", "team-a", row.wiki_id, 4);

    failStageRename.value = true;

    const newFixture = fixture();
    newFixture[1].content = "---\ntype: CustomType\n---\n\n NEW EXACT BYTES";

    expect(() => service.okfImport("service-a", "team-a", row.wiki_id, newFixture, true)).toThrowError("Simulated stage-rename failure");

    const fresh = store.getWikiById("service-a", row.wiki_id)!;
    expect(fresh.status).toBe("ready"); // Rolled back correctly

    const content = readFileSync(join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki/nested/a.md"), "utf-8");
    expect(content).toBe(fixture()[1].content);
  });

  it("typed rollback failure marks failed without raw synthetic-secret/path leakage and preserves OLD backup bytes", () => {
    const { service, row, store } = setup();
    service.okfIndexed("service-a", "team-a", row.wiki_id, 4);
    service.okfImport("service-a", "team-a", row.wiki_id, fixture());
    service.okfIndexed("service-a", "team-a", row.wiki_id, 4);

    failRename.value = true;

    const newFixture = fixture();
    newFixture[1].content = "---\ntype: CustomType\n---\n\n NEW EXACT BYTES";

    let caughtError: any;
    try {
      service.okfImport("service-a", "team-a", row.wiki_id, newFixture, true);
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(BundleRollbackError);
    expect(caughtError.message).toBe("Bundle swap failed and recovery rollback also failed");

    const fresh = store.getWikiById("service-a", row.wiki_id)!;
    expect(fresh.status).toBe("failed");
    expect(fresh.sync_error).toBe("Bundle rollback failed");
    expect(fresh.sync_error).not.toContain("secret");
    expect(fresh.sync_error).not.toContain(".okf-stage-");

    const backupContent = readFileSync(join(caughtError.backupPath, "nested/a.md"), "utf-8");
    expect(backupContent).toBe(fixture()[1].content);
  });
});
