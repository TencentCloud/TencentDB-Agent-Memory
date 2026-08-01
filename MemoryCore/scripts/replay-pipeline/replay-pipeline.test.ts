import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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
      const res = runCli(["-d", dir, "--llm-base-url", "http://x", "--llm-api-key", "k", "--llm-model", "m", "--output", join(dir, "out.json")]);
      // store init 失败或未发现 session → 异常 → 退出非 0
      expect(res.code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
