// 拓展档:白名单输入净化方案 + 端到端
// (白名单字符级 → buildFtsQuery 分词 → sanitizeFtsToken phrase 转义 → MATCH ? 参数绑定)
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { sanitizeFtsWhitelist, buildFtsQuery } from "./sqlite.js";

let DatabaseSync: any = null;
try {
  const mod = await import("node:sqlite");
  DatabaseSync = mod.DatabaseSync;
} catch {
  DatabaseSync = null;
}

describe("sanitizeFtsWhitelist — 字符级白名单(拓展档)", () => {
  it("普通输入原样保留", () => {
    expect(sanitizeFtsWhitelist("hello world")).toBe("hello world");
    expect(sanitizeFtsWhitelist("固态电池")).toBe("固态电池");
  });

  it("保留搜索常见的安全标点(- . /)", () => {
    expect(sanitizeFtsWhitelist("error-code")).toBe("error-code");
    expect(sanitizeFtsWhitelist("v1.0")).toBe("v1.0");
    expect(sanitizeFtsWhitelist("a/b")).toBe("a/b");
  });

  it("移除 FTS5 操作符字符:\" ' * ( ) : ^", () => {
    expect(sanitizeFtsWhitelist('a"b')).toBe("a b");
    expect(sanitizeFtsWhitelist("foo*")).toBe("foo");
    expect(sanitizeFtsWhitelist("(test)")).toBe("test");
    expect(sanitizeFtsWhitelist("title:secret")).toBe("title secret");
    expect(sanitizeFtsWhitelist("^foo")).toBe("foo");
  });

  it("组合载荷:危险字符被移除,普通词保留", () => {
    expect(sanitizeFtsWhitelist('a* OR (b:c)')).toBe("a OR b c");
  });

  it("纯危险字符 → 空串", () => {
    expect(sanitizeFtsWhitelist("***")).toBe("");
    expect(sanitizeFtsWhitelist('"""')).toBe("");
    expect(sanitizeFtsWhitelist("(:)")).toBe("");
  });

  it("多空格规整为单空格 + trim", () => {
    expect(sanitizeFtsWhitelist("  a    b  ")).toBe("a b");
  });

  it("空 / 非字符串 → 空串", () => {
    expect(sanitizeFtsWhitelist("")).toBe("");
    expect(sanitizeFtsWhitelist(undefined as any)).toBe("");
    expect(sanitizeFtsWhitelist(null as any)).toBe("");
  });
});

describe("白名单 + buildFtsQuery 组合(端到端安全)", () => {
  it("白名单后再分词+转义,产出合法且安全的 FTS5 查询", () => {
    const cleaned = sanitizeFtsWhitelist('a* OR (b:c) "inject'); // → "a OR b c inject"
    const q = buildFtsQuery(cleaned);
    expect(q).not.toBeNull();
    for (const seg of q!.split(" OR ")) {
      expect(seg.startsWith('"')).toBe(true);
      expect(seg.endsWith('"')).toBe(true);
    }
  });

  it("白名单独立防住危险字符(即使分词器不剥离)", () => {
    expect(sanitizeFtsWhitelist("foo*bar")).toBe("foo bar");
  });

  it("白名单产出空串时,buildFtsQuery 返回 null(避免空 MATCH)", () => {
    expect(buildFtsQuery(sanitizeFtsWhitelist("***"))).toBeNull();
  });
});

// 真实 FTS5 端到端:白名单 → buildFtsQuery → MATCH,不报语法错误且能召回
const d = DatabaseSync ? describe : describe.skip;
d("白名单端到端 — 真实 FTS5(拓展档)", () => {
  let db: any;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
    const ins = db.prepare("INSERT INTO docs VALUES (?)");
    for (const c of ["hello world", "foo bar baz", "error-code v1.0"]) ins.run(c);
  });
  afterEach(() => db.close());

  it("危险输入经白名单净化后,不触发 MATCH 语法错误", () => {
    const dangerous = '(unclosed " OR * ';
    const q = buildFtsQuery(sanitizeFtsWhitelist(dangerous));
    expect(() =>
      db.prepare("SELECT rowid FROM docs WHERE docs MATCH ?").all(q ?? ""),
    ).not.toThrow();
  });

  it("正常搜索经白名单后仍能召回(不损 recall)", () => {
    const q = buildFtsQuery(sanitizeFtsWhitelist("hello"));
    const rows = db.prepare("SELECT rowid FROM docs WHERE docs MATCH ?").all(q);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("含连字符的关键词经白名单保留后仍可召回", () => {
    const q = buildFtsQuery(sanitizeFtsWhitelist("error-code"));
    const rows = db.prepare("SELECT rowid FROM docs WHERE docs MATCH ?").all(q);
    expect(rows.length).toBeGreaterThan(0);
  });
});
