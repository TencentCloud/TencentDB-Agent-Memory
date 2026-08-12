/**
 * P10 — dashboard memory_health.md (#15) + digest last-digest.json (#13).
 * Uses a scratch dataDir with a throwaway vectors.db (created via the
 * runtime SQLite loader — no fs writes in this test file).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  writeDashboard,
  writeDigest,
  readDigest,
  countL1ByType,
  readLastRuns,
  buildDashboardMarkdown,
  digestPath,
} from "./reports.js";
import type { ProbeResult } from "./probe.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const require = createRequire(import.meta.url);

function openSqlite(dbPath: string): {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
  close(): void;
} {
  if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
    const { Database } = require("bun:sqlite") as {
      Database: new (p: string) => unknown;
    };
    return new Database(dbPath) as unknown as ReturnType<typeof openSqlite>;
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => unknown;
  };
  return new DatabaseSync(dbPath) as unknown as ReturnType<typeof openSqlite>;
}

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let tmp: string;
let dataDir: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-reports-"));
  dataDir = path.join(tmp, "tdai");
  fs.mkdirSync(dataDir, { recursive: true });
  // logs with two run reports (one failed, one ok)
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, "memory-keeper-2026-08-02T00-00-00.000Z.json"),
    JSON.stringify({
      status: "ok",
      startedAt: "2026-08-02T00:00:00.000Z",
      elapsedMs: 1200,
      newL0: 3,
      applied: { deletes: ["d1"] },
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(logsDir, "memory-keeper-2026-08-02T01-00-00.000Z.json"),
    JSON.stringify({
      status: "failed",
      startedAt: "2026-08-02T01:00:00.000Z",
      elapsedMs: 500,
      newL0: 0,
      error: "boom",
    }),
    "utf-8",
  );

  const db = openSqlite(path.join(dataDir, "vectors.db"));
  db.exec(
    "CREATE TABLE l1_records (" +
      "record_id TEXT PRIMARY KEY, content TEXT, type TEXT, priority INTEGER, scene_name TEXT, " +
      "session_key TEXT, session_id TEXT, timestamp_str TEXT, created_time TEXT, updated_time TEXT, metadata_json TEXT)",
  );
  db.prepare(
    "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) VALUES ('a', 'instruction one', 'instruction', 80, 't', 't')",
  ).run();
  db.prepare(
    "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) VALUES ('b', 'episodic one', 'episodic', 50, 't', 't')",
  ).run();
  db.prepare(
    "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) VALUES ('c', 'episodic two', 'episodic', 40, 't', 't')",
  ).run();
  db.close();

  // scene block within limits + one over
  const sceneDir = path.join(dataDir, "scene_blocks", "_global");
  fs.mkdirSync(sceneDir, { recursive: true });
  fs.writeFileSync(
    path.join(sceneDir, "ok.md"),
    "-----META-START-----\nsummary: t\n-----META-END-----\n\nshort",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(sceneDir, "big.md"),
    "-----META-START-----\nsummary: t\n-----META-END-----\n\n" +
      "x".repeat(1600),
    "utf-8",
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("digest (#13)", () => {
  it("writeDigest → readDigest roundtrip", () => {
    writeDigest(
      dataDir,
      {
        runAt: "2026-08-02T02:00:00.000Z",
        status: "ok",
        mergedDuplicates: 3,
        rewrittenScenes: 1,
        precisionAtK: 0.87,
        elapsedMs: 4500,
        newL0: 12,
        recordsPresented: 5,
      },
      silentLogger,
    );
    const d = readDigest(dataDir);
    expect(d).not.toBeNull();
    expect(d!.mergedDuplicates).toBe(3);
    expect(d!.precisionAtK).toBe(0.87);
    expect(d!.status).toBe("ok");
  });

  it("readDigest returns null for missing/malformed file", () => {
    expect(readDigest(path.join(tmp, "nope"))).toBeNull();
  });

  it("digest path lives under .metadata", () => {
    expect(digestPath(dataDir)).toBe(
      path.join(dataDir, ".metadata", "last-digest.json"),
    );
  });
});

describe("dashboard (#15)", () => {
  it("countL1ByType groups l1_records by type", () => {
    const byType = countL1ByType(dataDir, silentLogger);
    expect(byType.find((t) => t.type === "instruction")!.count).toBe(1);
    expect(byType.find((t) => t.type === "episodic")!.count).toBe(2);
  });

  it("readLastRuns returns newest reports with parsed fields", () => {
    const runs = readLastRuns(dataDir, 2);
    expect(runs.length).toBe(2);
    expect(runs[0]!.status).toBe("ok");
    expect(runs[1]!.status).toBe("failed");
  });

  it("buildDashboardMarkdown contains all sections", () => {
    const md = buildDashboardMarkdown({
      dataDir,
      logger: silentLogger,
      clustersSummary: "1 cluster(s), 2 member(s)",
    });
    expect(md).toContain("# Memory health");
    expect(md).toContain("## L1 by type");
    expect(md).toContain("**instruction**: 1");
    expect(md).toContain("## Duplicate clusters");
    expect(md).toContain("1 cluster(s), 2 member(s)");
    expect(md).toContain("## Scene sizes");
    expect(md).toContain("scene_blocks/_global/big.md");
    expect(md).toContain("OVER LIMIT");
    expect(md).toContain("## vec-vs-meta");
    expect(md).toContain("## Precision@k");
    expect(md).toContain("## Last runs");
  });

  it("buildDashboardMarkdown renders probe result", () => {
    const probe: ProbeResult = {
      status: "ok",
      queries: 4,
      topK: 3,
      precisionAtK: 0.75,
      top1HitRate: 0.5,
      evaluated: [],
    };
    const md = buildDashboardMarkdown({ dataDir, logger: silentLogger, probe });
    expect(md).toContain("precision@k: 75.0%");
    expect(md).toContain("top-1 hit rate: 50.0%");
  });

  it("writeDashboard writes memory_health.md atomically", async () => {
    const probe: ProbeResult = {
      status: "skipped",
      queries: 0,
      topK: 3,
      precisionAtK: null,
      top1HitRate: null,
      evaluated: [],
      reason: "no corpus",
    };
    const file = await writeDashboard({ dataDir, logger: silentLogger, probe });
    expect(file).toBe(path.join(dataDir, "memory_health.md"));
    const md = fs.readFileSync(file!, "utf-8");
    expect(md).toContain("## Precision@k");
    expect(md).toContain("skipped (no corpus)");
    // no leftover temp files
    const leftovers = fs
      .readdirSync(dataDir)
      .filter((f) => f.includes(".tmp-"));
    expect(leftovers).toHaveLength(0);
  });
});
