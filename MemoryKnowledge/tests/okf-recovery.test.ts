import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { WikiService } from "../src/store/wiki-service.js";
import { resolveRecovery, readJournal } from "../src/engines/wiki/okf-recovery.js";

const created: Array<{ root: string; raw: ReturnType<typeof createDb>["raw"] }> = [];
afterEach(() => {
  for (const { root, raw } of created.splice(0)) {
    raw.close();
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function setup() {
  const rawRoot = mkdtempSync(join(tmpdir(), "okf-recovery-"));
  const root = realpathSync(rawRoot);
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
];

describe("OKF Recovery Journal & Traversal Security", () => {
  it("rejects traversal and foreign wikiDir in journal", () => {
    const { service, row, root } = setup();
    const wikiDir = join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki");
    const journalPath = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");

    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, JSON.stringify({
      wikiDir: join(root, "data/service-a/team-a/other-wiki/wiki"),
      backupDir: `${wikiDir}.okf-backup-00000000-0000-0000-0000-000000000000`,
      stageDir: `${wikiDir}.okf-stage-00000000-0000-0000-0000-000000000000`,
      targetVersion: 2,
      phase: "started"
    }));

    expect(() => readJournal(journalPath, wikiDir, root)).toThrowError("Journal wikiDir mismatch");
  });

  it("rejects symlink journal file without touching targets", () => {
    const { service, row, root } = setup();
    const wikiDir = join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki");
    const journalPath = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");

    mkdirSync(dirname(journalPath), { recursive: true });

    const realJournal = join(root, "real-journal.json");
    writeFileSync(realJournal, JSON.stringify({
      wikiDir,
      backupDir: `${wikiDir}.okf-backup-00000000-0000-0000-0000-000000000000`,
      stageDir: `${wikiDir}.okf-stage-00000000-0000-0000-0000-000000000000`,
      targetVersion: 2,
      phase: "started"
    }));

    symlinkSync(realJournal, journalPath);

    expect(() => readJournal(journalPath, wikiDir, root)).toThrowError("Journal file is a symbolic link");
  });

  it("rejects naming violation in backupDir", () => {
    const { service, row, root } = setup();
    const wikiDir = join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki");
    const journalPath = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");

    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, JSON.stringify({
      wikiDir,
      backupDir: join(dirname(wikiDir), "hacked-backup"), // Naming violation
      stageDir: `${wikiDir}.okf-stage-00000000-0000-0000-0000-000000000000`,
      targetVersion: 2,
      phase: "started"
    }));

    expect(() => readJournal(journalPath, wikiDir, root)).toThrowError("Backup path naming violation");
  });
});

describe("OKF Recovery integration", () => {
  it("recovers from postcommit metadata failure (indexing phase)", () => {
    const { service, row, store } = setup();

    const originalUpdate = store.updateWikiStatus.bind(store);
    vi.spyOn(store, "updateWikiStatus").mockImplementation((sId, wId, patch) => {
      if (patch.version) {
        throw new Error("Simulated DB version update failure");
      }
      return originalUpdate(sId, wId, patch);
    });

    expect(() => service.okfImport("service-a", "team-a", row.wiki_id, fixture())).toThrowError("Simulated DB version update failure");

    const fresh = store.getWikiById("service-a", row.wiki_id)!;
    expect(fresh.status).toBe("failed");
    expect(fresh.version).toBe(row.version); // still old version

    vi.restoreAllMocks(); // allow updates now

    const result = service.okfRecover("service-a", "team-a", row.wiki_id);
    expect(result).not.toBeNull();
    if (result && typeof result === "object") {
      expect(result.action).toBe("rolled_forward");
    }

    const recovered = store.getWikiById("service-a", row.wiki_id)!;
    expect(recovered.status).toBe("processing");
    expect(recovered.version).toBe(row.version + 1);
  });

  it("recovers from process crash where stage exists but backup doesn't (initial import)", () => {
    const { service, row, store, root } = setup();

    // Setup initial crash state
    const wikiDir = join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki");
    const journalPath = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");

    mkdirSync(dirname(journalPath), { recursive: true });

    const stageDir = `${wikiDir}.okf-stage-00000000-0000-0000-0000-000000000000`;
    mkdirSync(stageDir); // Stage exists
    // backup does NOT exist
    // wiki does NOT exist

    writeFileSync(journalPath, JSON.stringify({
      wikiDir,
      backupDir: `${wikiDir}.okf-backup-00000000-0000-0000-0000-000000000000`,
      stageDir,
      targetVersion: row.version + 1,
      phase: "started"
    }));

    expect(() => service.okfRecover("service-a", "team-a", row.wiki_id))
      .toThrowError("Ambiguous recovery state requires operator intervention.");

    // evidence is preserved
    expect(existsSync(stageDir)).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("rejects ambiguous state: phase=started, wiki exists, no backup, no stage (operator intervention)", () => {
    const { service, row } = setup();
    const wikiDir = join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki");
    const journalPath = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");

    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, "sentinel.md"), "untouched");
    writeFileSync(journalPath, JSON.stringify({
      wikiDir,
      backupDir: `${wikiDir}.okf-backup-00000000-0000-0000-0000-000000000000`,
      stageDir: `${wikiDir}.okf-stage-00000000-0000-0000-0000-000000000000`,
      targetVersion: 2,
      phase: "started"
    }));

    // Recovery should fail and not touch the wiki directory or journal
    expect(() => service.okfRecover("service-a", "team-a", row.wiki_id))
      .toThrowError("Ambiguous recovery state requires operator intervention.");

    expect(existsSync(journalPath)).toBe(true);
    expect(readFileSync(join(wikiDir, "sentinel.md"), "utf-8")).toBe("untouched");
  });

  it("rejects 6-level deep parent symlink and leaves outside sentinel bytes unchanged", async () => {
    const { service, row, root } = setup();

    // We want to create a symlink 6 levels up.
    // service.dirFor returns root/data/service-a/team-a/wikiId
    // which is 4 levels deep from root (data, service-a, team-a, wikiId).
    // Let's create an explicit 6-level path.
    const deepRoot = join(root, "level1", "level2", "level3", "level4", "level5", "level6");
    mkdirSync(deepRoot, { recursive: true });

    const outsideParent = join(root, "outside-parent");
    mkdirSync(outsideParent, { recursive: true });
    const outsideSentinel = join(outsideParent, "sentinel.md");
    writeFileSync(outsideSentinel, "outside-bytes");

    // level3 is a symlink to outsideParent
    const level3 = join(root, "level1", "level2", "level3");
    rmSync(level3, { recursive: true, force: true });
    symlinkSync(outsideParent, level3);

    const wikiDir = join(deepRoot, "wiki");
    const journalPath = join(deepRoot, "okf-journal.json");

    mkdirSync(dirname(journalPath), { recursive: true });

    writeFileSync(journalPath, JSON.stringify({
      wikiDir,
      backupDir: `${wikiDir}.okf-backup-00000000-0000-0000-0000-000000000000`,
      stageDir: `${wikiDir}.okf-stage-00000000-0000-0000-0000-000000000000`,
      targetVersion: 2,
      phase: "started"
    }));

    const { readJournal } = await import("../src/engines/wiki/okf-recovery.js");
    expect(() => readJournal(journalPath, wikiDir, root))
      .toThrowError("Path or ancestor is a symbolic link");

    expect(readFileSync(outsideSentinel, "utf-8")).toBe("outside-bytes");
  });

  it("rejects applyRecovery if phase=indexing but live wikiDir is missing", () => {
    const { service, row, root } = setup();
    const wikiDir = join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki");
    const journalPath = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");

    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, JSON.stringify({
      wikiDir,
      backupDir: `${wikiDir}.okf-backup-00000000-0000-0000-0000-000000000000`,
      stageDir: `${wikiDir}.okf-stage-00000000-0000-0000-0000-000000000000`,
      targetVersion: row.version + 1,
      phase: "indexing"
    }));

    // backup exists, but NO wikiDir
    const backupDir = `${wikiDir}.okf-backup-00000000-0000-0000-0000-000000000000`;
    mkdirSync(backupDir);
    writeFileSync(join(backupDir, "sentinel.md"), "backup-bytes");

    expect(() => service.okfRecover("service-a", "team-a", row.wiki_id))
      .toThrowError("Ambiguous recovery state requires operator intervention.");

    // evidence is preserved
    expect(existsSync(journalPath)).toBe(true);
    expect(existsSync(backupDir)).toBe(true);
    expect(readFileSync(join(backupDir, "sentinel.md"), "utf-8")).toBe("backup-bytes");
  });

  it("rejects finishRecovery if phase=started or wikiDir is missing", async () => {
    const { service, row } = setup();
    const wikiDir = join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki");
    const journalPath = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");

    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, JSON.stringify({
      wikiDir,
      backupDir: `${wikiDir}.okf-backup-00000000-0000-0000-0000-000000000000`,
      stageDir: `${wikiDir}.okf-stage-00000000-0000-0000-0000-000000000000`,
      targetVersion: row.version,
      phase: "started"
    }));

    const backupDir = `${wikiDir}.okf-backup-00000000-0000-0000-0000-000000000000`;
    mkdirSync(backupDir);
    writeFileSync(join(backupDir, "sentinel.md"), "backup-bytes");

    const { finishRecovery } = await import("../src/engines/wiki/okf-recovery.js");

    // finishRecovery should throw and preserve evidence because phase=started
    expect(() => finishRecovery(journalPath, wikiDir, (service as any).dataRoot, row.version))
      .toThrowError("Cannot finalize recovery: journal is in ambiguous state or wiki directory is missing.");

    // evidence is preserved
    expect(existsSync(journalPath)).toBe(true);
    expect(existsSync(backupDir)).toBe(true);
  });

  it("preserves corrupt/ambiguous journals when finishRecovery is called on malformed JSON", async () => {
    const { service, row } = setup();
    const wikiDir = join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki");
    const journalPath = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");

    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, "{ malformed JSON");
    const backupDir = `${wikiDir}.okf-backup-00000000-0000-0000-0000-000000000000`;
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "sentinel.md"), "backup-bytes");

    const { finishRecovery } = await import("../src/engines/wiki/okf-recovery.js");

    expect(() => finishRecovery(journalPath, wikiDir, (service as any).dataRoot, row.version)).toThrowError("Journal file is malformed");

    // evidence is preserved
    expect(existsSync(journalPath)).toBe(true);
    expect(existsSync(backupDir)).toBe(true);
    expect(readFileSync(join(backupDir, "sentinel.md"), "utf-8")).toBe("backup-bytes");
  });

  it("treats repeated recovery after success as an idempotent no-op", () => {
    const { service, row } = setup();

    // Initial state has no journal
    const result = service.okfRecover("service-a", "team-a", row.wiki_id);
    expect(result).not.toBeNull();
    if (result && typeof result === "object") {
      expect(result.action).toBe("no_op");
      expect(result.message).toBe("No recovery pending (idempotent).");
    }
  });
});
