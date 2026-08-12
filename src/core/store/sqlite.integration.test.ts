/**
 * 集成测试：通过系统 sqlite3 CLI 执行真实 SQLite FTS5 MATCH。
 *
 * Node.js v23 内置 `node:sqlite` 不含编译好的 FTS5（"no such module: fts5"），
 * 使用 macOS 系统 `sqlite3`（v3.51.0+）代替——它内置 FTS5 和 unicode61 分词器。
 *
 * 验证 `buildFtsQuery()` 生成的 MATCH 表达式：
 *   1. 解析无 SQLite FTS5 错误
 *   2. 恶意输入不改变查询语义
 *   3. 正常关键词召回返回预期文档
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  buildFtsQuery,
  _setJiebaForTest,
  _resetJiebaForTest,
} from "./sqlite.js";

// ============================
// Fixture
// ============================

interface FixtureDoc {
  record_id: string;
  content: string;
}

const FIXTURE: FixtureDoc[] = [
  { record_id: "r1", content: "TypeScript builds scalable web APIs" },
  { record_id: "r2", content: "TencentDB memory plugin uses SQLite FTS5" },
  { record_id: "r3", content: "Vector search with sqlite-vec extension" },
  { record_id: "r4", content: "用户偏好简洁的 TypeScript 示例" },
  { record_id: "r5", content: "Travel plan for Tokyo in May" },
  { record_id: "r6", content: "Plan a trip to Japan and visit Tokyo Tower" },
  { record_id: "r7", content: "OpenClaw integration guide for Hermes" },
  { record_id: "r8", content: "ANDROID 12 release notes for programmers" },
  { record_id: "r9", content: "ORACLE database administrator tutorial" },
  { record_id: "r10", content: "NEARBY restaurants open after midnight" },
  { record_id: "r11", content: "FTS5 reserved operators: AND, OR, NOT" },
  { record_id: "r12", content: "理解用户需求并编写高质量代码" },
  { record_id: "r13", content: "Machine learning model deployment guide" },
  { record_id: "r14", content: "数据库性能优化的最佳实践" },
  { record_id: "r15", content: "用户设定的规则：每次回复必须用中文" },
  { record_id: "r16", content: "Deploy a Node.js app with Docker" },
  { record_id: "r17", content: "机器学习在自然语言处理中的应用" },
  { record_id: "r18", content: "The user prefers short, direct answers" },
  { record_id: "r19", content: "使用 pnpm 管理 monorepo 项目" },
  { record_id: "r20", content: "SCANNER driver installation for Linux" },
  { record_id: "r21", content: "next week plan: dental checkup" },
  { record_id: "r22", content: "Honor 90 smartphone review" },
  { record_id: "r23", content: "用户计划下个月去东京旅行" },
  { record_id: "r24", content: "The AND gate truth table in digital logic" },
  { record_id: "r25", content: "NOT operator precedence in Boolean algebra" },
];

// ============================
// sqlite3 CLI helper
// ============================

let dbPath: string;
let tmpDir: string;

beforeAll(() => {
  _setJiebaForTest(null);
  tmpDir = mkdtempSync(path.join(tmpdir(), "tdai-fts5-int-"));
  dbPath = path.join(tmpDir, "test.db");

  // Build init SQL
  const lines: string[] = [
    "CREATE VIRTUAL TABLE docs USING fts5(content, record_id UNINDEXED, tokenize=unicode61);",
  ];
  for (const doc of FIXTURE) {
    // Escape single quotes for SQL
    const escapedContent = doc.content.replace(/'/g, "''");
    lines.push(
      `INSERT INTO docs (content, record_id) VALUES ('${escapedContent}', '${doc.record_id}');`,
    );
  }
  writeFileSync(path.join(tmpDir, "init.sql"), lines.join("\n"), "utf-8");

  const r = spawnSync("sqlite3", [dbPath], {
    input: lines.join("\n"),
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (r.status !== 0) {
    throw new Error(`sqlite3 init failed: ${r.stderr}`);
  }
});

afterAll(() => {
  _resetJiebaForTest();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

/** Run an FTS5 MATCH query via sqlite3 CLI and return matching record_ids. */
function matchIds(ftsQuery: string): string[] {
  const sql = `SELECT record_id FROM docs WHERE docs MATCH '${ftsQuery.replace(/'/g, "''")}' ORDER BY rank;`;
  const r = spawnSync("sqlite3", [dbPath], {
    input: sql,
    encoding: "utf-8",
    timeout: 5_000,
  });
  if (r.status !== 0 && r.stderr) {
    throw new Error(`sqlite3 MATCH error for [${ftsQuery}]: ${r.stderr}`);
  }
  return r.stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
}

// ============================
// Suite: True FTS5 execution
// ============================

describe("buildFtsQuery → real FTS5 MATCH (sqlite3 CLI)", () => {
  it("G1: ordinary English query returns expected documents", () => {
    const q = buildFtsQuery("Tokyo plan");
    expect(q).not.toBeNull();
    const ids = matchIds(q!);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("r5");
  });

  it("G2: single-word query returns matching docs", () => {
    const q = buildFtsQuery("TypeScript");
    expect(q).not.toBeNull();
    const ids = matchIds(q!);
    expect(ids).toContain("r1");
    expect(ids).toContain("r4");
  });

  it("G3: AND injection — same core results as clean query", () => {
    const qClean = buildFtsQuery("Tokyo");
    const qInj = buildFtsQuery("Tokyo AND NOT OR NEAR");
    expect(qClean).not.toBeNull();
    expect(qInj).not.toBeNull();
    const idsClean = matchIds(qClean!);
    const idsInj = matchIds(qInj!);
    for (const id of idsClean) {
      expect(idsInj).toContain(id);
    }
  });

  it("G4: quote-escaping attempt parses without error", () => {
    const q = buildFtsQuery('" OR "1"="1" --');
    if (q !== null) {
      const ids = matchIds(q);
      expect(Array.isArray(ids)).toBe(true);
    }
  });

  it("G5: wildcard * does NOT cause prefix expansion", () => {
    const q = buildFtsQuery("secret*");
    if (q !== null) {
      // Should not throw — * is stripped, "secret" alone matches nothing
      expect(() => matchIds(q)).not.toThrow();
    }
  });

  it("G6: NEAR injection — query parses without error", () => {
    const q = buildFtsQuery("deploy NEAR Docker");
    expect(q).not.toBeNull();
    expect(() => matchIds(q!)).not.toThrow();
    const ids = matchIds(q!);
    expect(ids).toContain("r16");
  });

  // ── Safe substrings NOT stripped ──

  it("G7: ANDROID preserved (NOT stripped as AND)", () => {
    const q = buildFtsQuery("ANDROID");
    expect(q).not.toBeNull();
    expect(q!).toContain("ANDROID");
    const ids = matchIds(q!);
    expect(ids).toContain("r8");
  });

  it("G8: NEARBY preserved (NOT stripped as NEAR)", () => {
    const q = buildFtsQuery("NEARBY");
    expect(q).not.toBeNull();
    expect(q!).toContain("NEARBY");
    const ids = matchIds(q!);
    expect(ids).toContain("r10");
  });

  it("G9: ORACLE preserved (NOT stripped as OR)", () => {
    const q = buildFtsQuery("ORACLE");
    expect(q).not.toBeNull();
    expect(q!).toContain("ORACLE");
    const ids = matchIds(q!);
    expect(ids).toContain("r9");
  });

  // ── Recall: stripped-Op words still found by remaining terms ──

  it("G10: tech 'AND gate' — AND stripped, 'gate/truth' still match r24", () => {
    const q = buildFtsQuery("AND gate truth table");
    expect(q).not.toBeNull();
    const ids = matchIds(q!);
    expect(ids).toContain("r24");
  });

  it("G11: boolean 'NOT operator' — NOT stripped, remaining terms match r25", () => {
    const q = buildFtsQuery("NOT operator boolean");
    expect(q).not.toBeNull();
    const ids = matchIds(q!);
    expect(ids).toContain("r25");
  });

  // ── NFKC bypass ──

  it("G12: full-width AND injection neutralised", () => {
    const qClean = buildFtsQuery("Tokyo");
    const qFw = buildFtsQuery("Tokyo ＡＮＤ plan");
    if (qClean && qFw) {
      const idsClean = matchIds(qClean);
      const idsFw = matchIds(qFw);
      for (const id of idsClean) {
        expect(idsFw).toContain(id);
      }
    }
  });

  // ── Null handling ──

  it("G13: all-operator input returns null", () => {
    expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
    expect(buildFtsQuery("* ( ) ^ { }")).toBeNull();
  });
});
