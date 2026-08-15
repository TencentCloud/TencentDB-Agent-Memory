// 深入档验收:在【真实 FTS5 索引】上量化对比「转义(新)」vs「删除(旧)」
// 两种 quoting 策略的召回率(recall),实证:
//   1) 正常关键词:新版 recall == 旧版(零退化)
//   2) 含双引号的内容:新版召回、旧版漏召回 → recall 提升
//
// node:sqlite 在较旧 Node 上仍为 experimental;不可用时整体跳过本文件。
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { sanitizeFtsToken } from "./sqlite.js";

// 动态加载 node:sqlite(实验性模块,失败则跳过)
let DatabaseSync: any = null;
try {
  // top-level await: vitest 以 ESM 运行测试文件
  const mod = await import("node:sqlite");
  DatabaseSync = mod.DatabaseSync;
} catch {
  DatabaseSync = null;
}

// 复现【旧实现】的 quoting:删除双引号(而非转义)
const legacyQuote = (token: string): string => `"${token.replaceAll('"', "")}"`;

// 文档集(rowid = 插入顺序)。注意:刻意不含独立的 "ab"/"sayhi" 词,
// 以免旧版把 a"b 误当成 ab 时产生"误召",干扰 recall 对比。
const DOCS = [
  "hello world", // 1
  "say hi everyone", // 2
  'a"b special token', // 3  ← 含双引号
  "foo bar baz", // 4
  "react vue framework", // 5
];

const matchRowids = (db: any, fts: string): Set<number> => {
  if (!fts) return new Set();
  try {
    // 用 SQL 参数绑定传 fts 表达式(防 SQL 注入)
    const rows = db.prepare("SELECT rowid FROM docs WHERE docs MATCH ?").all(fts);
    return new Set(rows.map((r: { rowid: number }) => r.rowid));
  } catch {
    return new Set(); // 查询语法异常 → 视为无召回
  }
};

const recallOf = (matched: Set<number>, expected: number[]): number =>
  expected.length === 0 ? 0 : expected.filter((r) => matched.has(r)).length / expected.length;

const d = DatabaseSync ? describe : describe.skip;

d("recall — 真实 FTS5 索引上:转义(新) vs 删除(旧)", () => {
  let db: any;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
    const ins = db.prepare("INSERT INTO docs VALUES (?)");
    for (const c of DOCS) ins.run(c);
  });
  afterEach(() => db.close());

  it("正常关键词:两种策略召回集完全相同(零退化)", () => {
    for (const tok of ["hello", "foo", "react"]) {
      const newM = matchRowids(db, sanitizeFtsToken(tok));
      const legacyM = matchRowids(db, legacyQuote(tok));
      expect(newM).toEqual(legacyM); // 召回集一致 → 无退化
      expect(newM.size).toBeGreaterThan(0); // 且确实召回到
    }
  });

  it("含双引号的 token:a\"b → 转义召回(doc3)、删除漏召回", () => {
    const newM = matchRowids(db, sanitizeFtsToken('a"b'));
    const legacyM = matchRowids(db, legacyQuote('a"b'));
    expect(newM.has(3)).toBe(true); // doc 3 = 'a"b special token'
    expect(legacyM.has(3)).toBe(false);
    expect(newM.size).toBeGreaterThan(legacyM.size);
  });

  it("含双引号的短语:say\"hi → 转义召回(doc2)、删除漏召回", () => {
    const newM = matchRowids(db, sanitizeFtsToken('say"hi'));
    const legacyM = matchRowids(db, legacyQuote('say"hi'));
    expect(newM.has(2)).toBe(true); // doc 2 = 'say hi everyone'
    expect(legacyM.has(2)).toBe(false);
    expect(newM.size).toBeGreaterThan(legacyM.size);
  });

  it("recall 汇总:新版 recall >= 旧版;含双引号场景严格更优", () => {
    const queries: Array<{ tok: string; expected: number[]; quote: boolean }> = [
      { tok: "hello", expected: [1], quote: false },
      { tok: "foo", expected: [4], quote: false },
      { tok: "react", expected: [5], quote: false },
      { tok: 'a"b', expected: [3], quote: true },
      { tok: 'say"hi', expected: [2], quote: true },
    ];
    let improved = 0;
    for (const { tok, expected, quote } of queries) {
      const newR = recallOf(matchRowids(db, sanitizeFtsToken(tok)), expected);
      const legacyR = recallOf(matchRowids(db, legacyQuote(tok)), expected);
      expect(newR).toBeGreaterThanOrEqual(legacyR); // 不退化
      if (quote) {
        expect(newR).toBeGreaterThan(legacyR); // 含双引号严格提升
        improved++;
      }
    }
    expect(improved).toBeGreaterThan(0); // 至少一个场景实证提升
  });
});
