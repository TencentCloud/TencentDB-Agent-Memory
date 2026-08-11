/**
 * P11a — cleanup tests (wave tdai-memory-subagents-2026-08-02).
 *
 * Fake files only: old logs/diffs/backups removed, records/vectors untouched,
 * stale scratch run dirs removed, the deterministic tasks subtree for the
 * scratch cwd removed while unrelated user task dirs survive; the scratch-cwd
 * sanitizer rejects `..` / absolute paths.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../core/types.js";
import {
  sanitizeCwdToken,
  sanitizeAbsoluteCwdToken,
  tasksSubtreeForScratch,
  listTaskSubtrees,
  runCleanup,
  CleanupTimer,
  type CleanupStats,
} from "./cleanup.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Set an old mtime on a file/dir (older than the 24h maxAge). */
function ageByDays(p: string, days: number): void {
  const t = new Date(Date.now() - days * 24 * 3600 * 1000);
  fs.utimesSync(p, t, t);
}

describe("cleanup sanitizer", () => {
  it("rejects absolute paths, ~ and .. traversal", () => {
    expect(sanitizeCwdToken("/home/user/x")).toBeNull();
    expect(sanitizeCwdToken("~/x")).toBeNull();
    expect(sanitizeCwdToken("../x")).toBeNull();
    expect(sanitizeCwdToken("a/../../x")).toBeNull();
    expect(sanitizeCwdToken("..")).toBeNull();
    expect(sanitizeCwdToken("")).toBeNull();
  });

  it("sanitizes relative cwd into the tasks-dir token (pi pattern)", () => {
    expect(sanitizeCwdToken("home/penis")).toBe("home-penis");
    expect(sanitizeCwdToken("home/penis/projects/eleishkina")).toBe(
      "home-penis-projects-eleishkina",
    );
    expect(sanitizeCwdToken(".pi/agent-memory/tdai-memory-keeper")).toBe(
      "-pi-agent-memory-tdai-memory-keeper",
    );
    // Absolute-path variant mirrors pi's behavior on real cwds.
    expect(sanitizeAbsoluteCwdToken("/home/penis")).toBe("home-penis");
    expect(sanitizeAbsoluteCwdToken("/home/penis/projects/mininotion")).toBe(
      "home-penis-projects-mininotion",
    );
  });

  it("tasksSubtreeForScratch derives the deterministic ~/.pi/agent/tasks/--<token>--/ path", () => {
    const home = "/home/testuser";
    const subtree = tasksSubtreeForScratch({
      home,
      cwd: path.join(
        home,
        ".pi",
        "agent-memory",
        "tdai-memory-keeper",
        "run-1",
      ),
    });
    expect(subtree).toBe(
      path.join(
        home,
        ".pi",
        "agent",
        "tasks",
        "--home-testuser--pi-agent-memory-tdai-memory-keeper-run-1--",
      ),
    );
  });
});

describe("runCleanup", () => {
  let tmp: string;
  let dataDir: string;
  let scratchRoot: string;
  let home: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cleanup-"));
    dataDir = path.join(tmp, "tdai");
    scratchRoot = path.join(tmp, "scratch-root");
    home = path.join(tmp, "home");
    fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, ".backup"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "records"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
      recursive: true,
    });
    fs.mkdirSync(scratchRoot, { recursive: true });
    fs.mkdirSync(path.join(home, ".pi", "agent", "tasks"), { recursive: true });
    // Memory data that MUST survive.
    fs.writeFileSync(
      path.join(dataDir, "records", "2026-08-01.jsonl"),
      '{"k":1}\n',
    );
    fs.writeFileSync(path.join(dataDir, "vectors.db"), "not-a-real-db");
    fs.writeFileSync(path.join(dataDir, "persona.md"), "# persona");
    fs.writeFileSync(
      path.join(dataDir, "scene_blocks", "_global", "ok.md"),
      "# scene",
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeDeps(
    overrides: {
      paths?: string[];
      intervalHours?: number;
      extraScratchRoots?: string[];
    } = {},
  ) {
    return {
      dataDir,
      scratchRoot,
      extraScratchRoots: overrides.extraScratchRoots,
      home,
      config: {
        enabled: true,
        intervalHours: overrides.intervalHours ?? 24,
        paths: overrides.paths ?? ["logs"],
      },
      now: () => Date.now(),
      logger: silentLogger,
    };
  }

  it("removes old logs/diff sidecars/backups; keeps fresh ones; never touches records/vectors", () => {
    // Old artifacts (2 days — older than the 24h maxAge).
    const oldLog = path.join(dataDir, "logs", "memory-keeper-old.json");
    const oldDiff = path.join(dataDir, "logs", "memory-keeper-old.diff.md");
    const oldBackup = path.join(
      dataDir,
      ".backup",
      "apply-2026-07-01-ok.md.bak",
    );
    fs.writeFileSync(oldLog, "{}");
    fs.writeFileSync(oldDiff, "## diff");
    fs.writeFileSync(oldBackup, "content");
    ageByDays(oldLog, 2);
    ageByDays(oldDiff, 2);
    ageByDays(oldBackup, 2);

    // Fresh artifact (today) — must survive.
    const freshLog = path.join(dataDir, "logs", "memory-keeper-fresh.json");
    fs.writeFileSync(freshLog, "{}");

    const stats = runCleanup(makeDeps({ paths: ["logs", ".backup"] }));

    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(oldDiff)).toBe(false);
    expect(fs.existsSync(oldBackup)).toBe(false);
    expect(fs.existsSync(freshLog)).toBe(true);

    // Memory data untouched.
    expect(
      fs.existsSync(path.join(dataDir, "records", "2026-08-01.jsonl")),
    ).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "vectors.db"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "persona.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(dataDir, "scene_blocks", "_global", "ok.md")),
    ).toBe(true);
    expect(stats.errors).toEqual([]);
  });

  it("removes stale scratch run dirs (crash leftovers), keeps fresh ones", () => {
    const staleRun = path.join(scratchRoot, "run-stale");
    const freshRun = path.join(scratchRoot, "run-fresh");
    fs.mkdirSync(staleRun, { recursive: true });
    fs.mkdirSync(freshRun, { recursive: true });
    fs.writeFileSync(path.join(staleRun, "diff.json"), "{}");
    ageByDays(staleRun, 3);
    ageByDays(path.join(staleRun, "diff.json"), 3);

    runCleanup(makeDeps());

    expect(fs.existsSync(staleRun)).toBe(false);
    expect(fs.existsSync(freshRun)).toBe(true);
  });

  it("dry-run scratch dirs (retained with tools/, preserved by the orchestrator) are age-swept too", () => {
    // A dry-run run leaves scratch/<runId>/ with tools/ behind for inspection;
    // retention must be bounded by the same age sweep (maxAge = intervalHours).
    const dryRunScratch = path.join(
      scratchRoot,
      "dry-2026-08-02T12-00-00-000Z",
    );
    fs.mkdirSync(path.join(dryRunScratch, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dryRunScratch, "tools", "fetch_dups.py"), "x");
    fs.writeFileSync(
      path.join(dryRunScratch, "memory-keeper-prompt.md"),
      "# diff",
    );
    ageByDays(dryRunScratch, 3);
    ageByDays(path.join(dryRunScratch, "tools"), 3);
    ageByDays(path.join(dryRunScratch, "tools", "fetch_dups.py"), 3);

    runCleanup(makeDeps());

    expect(fs.existsSync(dryRunScratch)).toBe(false);
    // Memory data untouched.
    expect(
      fs.existsSync(path.join(dataDir, "records", "2026-08-01.jsonl")),
    ).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "vectors.db"))).toBe(true);
  });

  it("removes the deterministic tasks subtree for scratch cwds, keeps unrelated user tasks", () => {
    // Sub-tree that a failing task-simple prompt-override would have created
    // (child cwd = scratchRoot/<runId>).
    const childCwd = path.join(scratchRoot, "run-abc");
    fs.mkdirSync(childCwd, { recursive: true });
    const derived = tasksSubtreeForScratch({ home, cwd: childCwd });
    expect(derived).not.toBeNull();
    fs.mkdirSync(path.join(derived!, "2026-08-02"), { recursive: true });
    fs.writeFileSync(path.join(derived!, "2026-08-02", "120000-x.md"), "");
    // Marker-sweep target: a sanitizer-mismatched dir name containing the
    // scratch marker (basename of scratchRoot → "scratch-root").
    const markerDir = path.join(
      home,
      ".pi",
      "agent",
      "tasks",
      "--home-test-scratch-root-zzz--",
    );
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, "junk.md"), "x");
    // Unrelated user task dir — must survive.
    const userTasks = path.join(home, ".pi", "agent", "tasks", "--home-test--");
    fs.mkdirSync(path.join(userTasks, "2026-08-02"), { recursive: true });
    fs.writeFileSync(
      path.join(userTasks, "2026-08-02", "real-task.md"),
      "important",
    );

    const stats = runCleanup(makeDeps());

    expect(fs.existsSync(derived!)).toBe(false);
    expect(fs.existsSync(markerDir)).toBe(false);
    expect(
      fs.existsSync(path.join(userTasks, "2026-08-02", "real-task.md")),
    ).toBe(true);
    expect(stats.errors).toEqual([]);
  });

  it("rejects non-dataDir-relative configured paths and protected memory paths", () => {
    const stats = runCleanup(
      makeDeps({
        paths: [
          "/etc",
          "../outside",
          "records",
          "vectors.db",
          "scene_blocks",
          "persona.md",
        ],
      }),
    );
    expect(stats.errors.some((e) => e.includes("rejected"))).toBe(true);
    // The protected paths were rejected BEFORE removal — memory data intact.
    expect(
      fs.existsSync(path.join(dataDir, "records", "2026-08-01.jsonl")),
    ).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "vectors.db"))).toBe(true);
    expect(
      fs.existsSync(path.join(dataDir, "scene_blocks", "_global", "ok.md")),
    ).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "persona.md"))).toBe(true);
  });

  it("rejects paths resolving to the dataDir root ('.', './') — no root sweep", () => {
    // Age the memory data so a root sweep WOULD delete it (the P11a
    // acceptance: records/vectors must never be touched).
    const recordFile = path.join(dataDir, "records", "2026-08-01.jsonl");
    const vecDb = path.join(dataDir, "vectors.db");
    ageByDays(recordFile, 3);
    ageByDays(vecDb, 3);

    const stats = runCleanup(makeDeps({ paths: [".", "./"] }));

    // Both variants rejected as non-dataDir-relative → error recorded, no sweep.
    expect(stats.errors.some((e) => e.includes("rejected"))).toBe(true);
    expect(
      stats.scanned.some((p) => path.resolve(p) === path.resolve(dataDir)),
    ).toBe(false);
    expect(fs.existsSync(recordFile)).toBe(true);
    expect(fs.existsSync(vecDb)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "persona.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(dataDir, "scene_blocks", "_global", "ok.md")),
    ).toBe(true);
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  // A role writes its own runtime.scratch_root and the schema only checks that
  // it is a string, so this recursive delete takes its target from role.json.
  // Refuse the roots that could reach memory data instead of sweeping them.
  it("refuses a role scratch root that is (or holds) the memory tree", () => {
    const old = new Date(Date.now() - 3 * 24 * 3_600_000);
    fs.mkdirSync(path.join(dataDir, "runs"), { recursive: true });
    fs.utimesSync(path.join(dataDir, "scene_blocks"), old, old);
    fs.utimesSync(path.join(dataDir, "records"), old, old);

    const stats = runCleanup(
      makeDeps({
        paths: [],
        intervalHours: 1,
        extraScratchRoots: [dataDir, tmp, path.join(dataDir, "runs")],
      }) as never,
    );

    expect(fs.existsSync(path.join(dataDir, "scene_blocks"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "records"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "vectors.db"))).toBe(true);
    // Refused WITH a reason — a silent skip would look like "nothing to do".
    expect(stats.errors.join("\n")).toMatch(/is the data dir itself/);
    expect(stats.errors.join("\n")).toMatch(/contains the data dir/);
    // ...and the legitimate per-role root under it is still swept.
    expect(stats.scanned).toContain(path.join(dataDir, "runs"));
  });

  it("disabled cleanup is a no-op", () => {
    const oldLog = path.join(dataDir, "logs", "old.json");
    fs.writeFileSync(oldLog, "{}");
    ageByDays(oldLog, 5);
    runCleanup({
      ...makeDeps(),
      config: { enabled: false, intervalHours: 24, paths: ["logs"] },
    });
    expect(fs.existsSync(oldLog)).toBe(true);
  });

  it("listTaskSubtrees finds only --<name>-- dirs", () => {
    fs.mkdirSync(path.join(home, ".pi", "agent", "tasks", "--abc--"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "tasks", "not-a-subtree"),
      "x",
    );
    const dirs = listTaskSubtrees(home);
    expect(dirs).toEqual([path.join(home, ".pi", "agent", "tasks", "--abc--")]);
  });
});

describe("CleanupTimer", () => {
  it("start() is a no-op when disabled; runs immediately when enabled; stop() clears the timer", () => {
    const runs: string[] = [];
    const t1 = new CleanupTimer({
      enabled: false,
      intervalHours: 24,
      run: () => {
        runs.push("x");
        return {
          removedFiles: 0,
          removedDirs: 0,
          errors: [],
          scanned: [],
        } as CleanupStats;
      },
      now: () => Date.now(),
      logger: silentLogger,
    });
    t1.start();
    expect(runs).toEqual([]); // disabled → no immediate run
    expect(t1.isRunning).toBe(false);

    const t2 = new CleanupTimer({
      enabled: true,
      intervalHours: 24,
      run: () => {
        runs.push("y");
        return {
          removedFiles: 0,
          removedDirs: 0,
          errors: [],
          scanned: [],
        } as CleanupStats;
      },
      now: () => Date.now(),
      logger: silentLogger,
    });
    t2.start();
    // Immediate first pass is async — let the microtask queue settle.
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(runs).toContain("y");
        t2.stop();
        expect(t2.isRunning).toBe(false);
        resolve();
      }, 30),
    );
  });
});
