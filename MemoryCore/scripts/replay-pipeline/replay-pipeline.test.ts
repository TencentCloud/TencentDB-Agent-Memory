import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, statSync, rmSync, symlinkSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { CheckpointManager } from "../../src/utils/checkpoint.js";
import { LocalStorageBackend } from "../../src/core/storage/local-backend.js";
import { StorageAdapter } from "../../src/core/storage/adapter.js";

const require = createRequire(import.meta.url);

function checkpointFor(dir: string): CheckpointManager {
  return new CheckpointManager(dir, undefined, new StorageAdapter(new LocalStorageBackend(dir)));
}

/** 用 node:sqlite 写入最小 l0_conversations 表，供 store init 复用 schema。 */
function writeSqliteL0(dbPath: string, rows: Array<[string, string]>): void {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS l0_conversations (record_id TEXT PRIMARY KEY, session_key TEXT, session_id TEXT, role TEXT, message_text TEXT, recorded_at TEXT, timestamp INTEGER)",
    );
    const stmt = db.prepare("INSERT OR REPLACE INTO l0_conversations VALUES (?,?,?,?,?,?,?)");
    for (const [id, key] of rows) {
      stmt.run(id, key, "s1", "user", "hello world this is a real message", new Date().toISOString(), Date.now());
    }
  } finally {
    db.close();
  }
}

const CLI = join(__dirname, "replay-pipeline.ts");
const MODULE_ROOT = join(__dirname, "..", "..", ".."); // MemoryCore root

function runCli(args: string[], opts?: { cwd?: string; allowFail?: boolean }): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI, ...args], {
      cwd: opts?.cwd ?? MODULE_ROOT,
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { stdout, stderr: "", code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.status ?? 1 };
  }
}

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
  mkdirSync(join(dir, "scene_blocks"), { recursive: true });
  mkdirSync(join(dir, ".metadata"), { recursive: true });
  mkdirSync(join(dir, "profiles", encodeURIComponent("team:T1|agent:A1"), "scene_blocks"), { recursive: true });
  mkdirSync(join(dir, "profiles", encodeURIComponent("team:T1|agent:A1"), ".metadata"), { recursive: true });
  writeFileSync(join(dir, "scene_blocks", "root.md"), "root scene");
  writeFileSync(join(dir, "persona.md"), "ROOT PERSONA");
  writeFileSync(join(dir, ".metadata", "checkpoint.json"), "{\"total_processed\":5}");
  writeFileSync(join(dir, ".metadata", "scene_index.json"), "[]");
  writeFileSync(join(dir, "profiles", encodeURIComponent("team:T1|agent:A1"), "scene_blocks", "scoped.md"), "scoped scene");
  writeFileSync(join(dir, "profiles", encodeURIComponent("team:T1|agent:A1"), "persona.md"), "SCOPED PERSONA");
  writeFileSync(join(dir, "profiles", encodeURIComponent("team:T1|agent:A1"), ".metadata", "checkpoint.json"), "{\"total_processed\":5}");
  return dir;
}

describe("replay-pipeline CLI", () => {
  it("rejects --no-copy + --clean without --dangerous", () => {
    const dir = makeFixture();
    try {
      const res = runCli(["-d", dir, "--no-copy", "--clean", "--llm-base-url", "http://x", "--llm-api-key", "k", "--llm-model", "m", "--output", join(dir, "out.json")]);
      const text = res.stdout + res.stderr;
      expect(res.code).not.toBe(0);
      expect(text).toContain("--dangerous");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects --no-copy + --session-key + --clean", () => {
    const dir = makeFixture();
    try {
      const res = runCli(["-d", dir, "--no-copy", "--clean", "--session-key", "sess", "--llm-base-url", "http://x", "--llm-api-key", "k", "--llm-model", "m", "--output", join(dir, "out.json")]);
      const text = res.stdout + res.stderr;
      expect(res.code).not.toBe(0);
      expect(text).toContain("无法局部清理");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--list-sessions lists session keys from sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
    try {
      writeSqliteL0(join(dir, "vectors.db"), [["r1", "sess_a"]]);
      const res = runCli(["-d", dir, "--list-sessions"]);
      const text = res.stdout + res.stderr;
      expect(res.code).toBe(0);
      expect(text).toContain("sess_a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomic report write forces 0600 even when overwriting a 0644 file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
    const fixture = makeFixture();
    try {
      const out = join(dir, "report.json");
      writeFileSync(out, "old", { mode: 0o644 });
      // 用真实 store 初始化 + 无法连上的 LLM：L1 阶段失败 → 退出码 1，
      // 但报告仍会被写入。验证覆盖 0644 文件后权限收紧为 0600。
      writeSqliteL0(join(fixture, "vectors.db"), [["r1", "sess"]]);
      const res = runCli(["-d", fixture, "--stages", "L1", "--session-key", "sess", "--llm-base-url", "http://localhost:1", "--llm-api-key", "k", "--llm-model", "m", "--output", out]);
      expect(res.code).toBe(1); // L1 阶段失败 → 退出码 1，但报告仍写入
      const mode = statSync(out).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("workdir is cleaned up on exception path (store init failure leaves no temp dir)", () => {
    // 一个没有 vectors.db 的 data dir：copyDataDir 后 store init 失败 → 抛异常，
    // finally 应清理临时目录。
    const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
    try {
      const before = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith("replay-")));
      const res = runCli(["-d", dir, "--llm-base-url", "http://x", "--llm-api-key", "k", "--llm-model", "m", "--output", join(dir, "out.json")]);
      expect(res.code).not.toBe(0);
      const after = readdirSync(tmpdir()).filter((d) => d.startsWith("replay-"));
      const leaked = after.filter((d) => !before.has(d));
      expect(leaked).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("symlink workdir pointing at data-dir is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
    try {
      const link = join(tmpdir(), `replay-link-${Date.now()}`);
      try { symlinkSync(dir, link); } catch { return; } // 平台不支持则跳过
      try {
        const res = runCli(["-d", dir, "--work-dir", link, "--clean", "--llm-base-url", "http://x", "--llm-api-key", "k", "--llm-model", "m", "--output", join(dir, "out.json")]);
        const text = res.stdout + res.stderr;
        expect(res.code).not.toBe(0);
        expect(text).toContain("真实目录");
      } finally {
        rmSync(link, { force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a workdir below a symlink when intermediate directories do not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
    const link = join(tmpdir(), `replay-link-${Date.now()}`);
    try {
      try { symlinkSync(dir, link); } catch { return; }
      const nestedWork = join(link, "new", "child");
      const res = runCli([
        "-d", dir,
        "--work-dir", nestedWork,
        "--llm-base-url", "http://x",
        "--llm-api-key", "k",
        "--llm-model", "m",
      ]);
      const text = res.stdout + res.stderr;
      expect(res.code).not.toBe(0);
      expect(text).toContain("不能互为子目录");
    } finally {
      rmSync(link, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copy does not leak vectors.db sidecar files (-wal/-shm/-journal)", () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
    try {
      writeSqliteL0(join(dir, "vectors.db"), [["r1", "sess"]]);
      writeFileSync(join(dir, "vectors.db-wal"), "wal");
      writeFileSync(join(dir, "vectors.db-shm"), "shm");
      // 用 --work-dir 指向新目录，触发 copyDataDir
      const work = join(tmpdir(), `replay-copy-${Date.now()}`);
      rmSync(work, { force: true, recursive: true });
      try {
        const res = runCli(["-d", dir, "--work-dir", work, "--llm-base-url", "http://x", "--llm-api-key", "k", "--llm-model", "m", "--output", join(work, "out.json")]);
        // LLM 失败 → 非 0，但 copyDataDir 已执行
        expect(res.code).not.toBe(0);
        const files = readdirSync(work);
        const sidecars = files.filter((f) => f.startsWith("vectors.db-"));
        expect(sidecars).toEqual([]);
      } finally {
        rmSync(work, { force: true, recursive: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("L1-only clean clears downstream scenes and persona", () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
    try {
      mkdirSync(join(dir, "scene_blocks"), { recursive: true });
      writeFileSync(join(dir, "scene_blocks", "keep.md"), "scene");
      writeFileSync(join(dir, "persona.md"), "PERSONA");
      writeSqliteL0(join(dir, "vectors.db"), [["r1", "sess"]]);
      // --stages L1 --clean --no-copy（--dangerous 确认）：直接在原目录执行 clean。
      // L1 重建会使下游失效 → 应删除 scenes/persona。
      const res = runCli(["-d", dir, "--stages", "L1", "--clean", "--no-copy", "--dangerous", "--llm-base-url", "http://localhost:1", "--llm-api-key", "k", "--llm-model", "m", "--output", join(dir, "out.json")]);
      // LLM 失败非 0，但 clean 在运行前已执行
      expect(res.code).not.toBe(0);
      expect(existsSync(join(dir, "scene_blocks", "keep.md"))).toBe(false);
      expect(existsSync(join(dir, "persona.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks an L2 skip and clears its pending count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
    try {
      writeSqliteL0(join(dir, "vectors.db"), [["r1", "sess"]]);
      const checkpoint = checkpointFor(dir);
      await checkpoint.patchPipelineState("sess", {
        l2_pending_l1_count: 4,
        last_active_time: 123,
      });
      const output = join(dir, "report.json");

      const res = runCli([
        "-d", dir,
        "--stages", "L2",
        "--keep-state",
        "--no-copy",
        "--session-key", "sess",
        "--llm-base-url", "http://localhost:1",
        "--llm-api-key", "k",
        "--llm-model", "m",
        "--output", output,
      ]);

      expect(res.code).toBe(0);
      const report = JSON.parse(readFileSync(output, "utf-8")) as {
        results: { L2: { status: string } };
      };
      expect(report.results.L2.status).toBe("skipped");
      expect((await checkpoint.read()).pipeline_states.sess.l2_pending_l1_count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("L2-only clean preserves the global L1 runner cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
    try {
      writeSqliteL0(join(dir, "vectors.db"), [["r1", "sess"]]);
      mkdirSync(join(dir, "scene_blocks"), { recursive: true });
      writeFileSync(join(dir, "scene_blocks", "old.md"), "old scene");
      const checkpoint = checkpointFor(dir);
      await checkpoint.markL1ExtractionComplete("sess", 2, 987654321, "old scene");
      const output = join(dir, "report.json");

      const res = runCli([
        "-d", dir,
        "--stages", "L2",
        "--no-copy",
        "--clean",
        "--dangerous",
        "--llm-base-url", "http://localhost:1",
        "--llm-api-key", "k",
        "--llm-model", "m",
        "--output", output,
      ]);

      expect(res.code).toBe(0);
      const state = (await checkpoint.read()).runner_states.sess;
      expect(state.last_l1_cursor).toBe(987654321);
      expect(existsSync(join(dir, "scene_blocks", "old.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses sessions from a reused workdir snapshot", () => {
    const source = mkdtempSync(join(tmpdir(), "replay-source-"));
    const work = mkdtempSync(join(tmpdir(), "replay-work-"));
    try {
      writeSqliteL0(join(source, "vectors.db"), [["r-new", "session-new"]]);
      writeSqliteL0(join(work, "vectors.db"), [["r-old", "session-old"]]);
      const output = join(work, "report.json");

      const res = runCli([
        "-d", source,
        "--work-dir", work,
        "--stages", "L2",
        "--keep-state",
        "--llm-base-url", "http://localhost:1",
        "--llm-api-key", "k",
        "--llm-model", "m",
        "--output", output,
      ]);

      expect(res.code).toBe(0);
      const report = JSON.parse(readFileSync(output, "utf-8")) as {
        results: { L2: { detail: { sessions: string[] } } };
      };
      expect(report.results.L2.detail.sessions).toEqual(["session-old"]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("limits keep-state profile keys to the selected session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
    try {
      writeSqliteL0(join(dir, "vectors.db"), [["r-a", "session-a"], ["r-b", "session-b"]]);
      const checkpoint = checkpointFor(dir);
      await checkpoint.patchPipelineState("session-a", {});
      await checkpoint.patchPipelineState("profile:team:T1|agent:A1|session:session-a", {});
      await checkpoint.patchPipelineState("profile:team:T2|agent:A2|session:session-b", {});
      const output = join(dir, "report.json");

      const res = runCli([
        "-d", dir,
        "--stages", "L2",
        "--keep-state",
        "--no-copy",
        "--session-key", "session-a",
        "--llm-base-url", "http://localhost:1",
        "--llm-api-key", "k",
        "--llm-model", "m",
        "--output", output,
      ]);

      expect(res.code).toBe(0);
      const report = JSON.parse(readFileSync(output, "utf-8")) as {
        results: { L2: { detail: { l2Keys: string[] } } };
      };
      expect(report.results.L2.detail.l2Keys).toEqual([
        "profile:team:T1|agent:A1|session:session-a",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
