import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  _setJiebaForTest,
  buildFtsQuery,
  sanitizeFtsQueryInput,
} from "./sqlite.js";

interface ContentRow {
  content: string;
}

function searchFts(documents: string[], rawQuery: string): string[] {
  const db = new DatabaseSync(":memory:");

  try {
    db.exec("CREATE VIRTUAL TABLE documents USING fts5(content)");
    const insert = db.prepare("INSERT INTO documents(content) VALUES (?)");
    for (const document of documents) insert.run(document);

    const query = buildFtsQuery(rawQuery);
    if (!query) return [];

    return db
      .prepare("SELECT content FROM documents WHERE documents MATCH ? ORDER BY rowid")
      .all(query)
      .map((row) => (row as unknown as ContentRow).content);
  } finally {
    db.close();
  }
}

afterEach(() => {
  _setJiebaForTest(null);
});

describe("sanitizeFtsQueryInput", () => {
  it("removes FTS5 syntax while preserving searchable words", () => {
    expect(
      sanitizeFtsQueryInput(
        `^"alpha" + 'beta' (gamma) AND OR NOT NEAR delta* column:epsilon {zeta eta} -theta,10`,
      ),
    ).toBe(
      "alpha beta gamma AND OR NOT NEAR delta column epsilon zeta eta theta 10",
    );
  });

  it("preserves normal Unicode keywords and normalizes separators", () => {
    expect(sanitizeFtsQueryInput("TypeScript  记忆_search\nO'Reilly")).toBe(
      "TypeScript 记忆_search O Reilly",
    );
  });

  it("returns an empty string for syntax-only input", () => {
    expect(sanitizeFtsQueryInput(`"'()[]{}:+-^*,`)).toBe("");
  });
});

describe("buildFtsQuery FTS5 safety", () => {
  it("quotes operator names as literal search terms", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha AND beta OR NOT NEAR")).toBe(
      `"alpha" OR "AND" OR "beta" OR "OR" OR "NOT" OR "NEAR"`,
    );
  });

  it("sanitizes tokens returned by the segmenter", () => {
    _setJiebaForTest({
      cutForSearch: () => [`alpha" OR beta*`, "(gamma)", "O'Reilly"],
    });

    expect(buildFtsQuery("ignored")).toBe(
      `"alpha" OR "OR" OR "beta" OR "gamma" OR "O" OR "Reilly"`,
    );
  });

  it("returns null when no searchable token remains", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery(`"'()***`)).toBeNull();
  });

  it("does not allow boolean operators to exclude matches", () => {
    _setJiebaForTest(null);

    expect(searchFts(["alpha", "beta", "alpha beta"], "alpha NOT beta")).toEqual([
      "alpha",
      "beta",
      "alpha beta",
    ]);
  });

  it("preserves ordinary multi-keyword OR recall", () => {
    _setJiebaForTest(null);

    expect(
      searchFts(
        [
          "typescript memory plugin",
          "typescript compiler",
          "memory storage",
          "unrelated document",
        ],
        "typescript memory",
      ),
    ).toEqual([
      "typescript memory plugin",
      "typescript compiler",
      "memory storage",
    ]);
  });

  it("does not allow prefix, phrase, grouping, or NEAR semantics", () => {
    _setJiebaForTest(null);
    const documents = ["alpha", "alphabet", "beta", "alpha beta", "alpha far beta"];

    expect(searchFts(documents, "alpha*")).toEqual([
      "alpha",
      "alpha beta",
      "alpha far beta",
    ]);
    expect(searchFts(documents, `"alpha beta"`)).toEqual([
      "alpha",
      "beta",
      "alpha beta",
      "alpha far beta",
    ]);
    expect(searchFts(documents, "NEAR(alpha beta)")).toEqual([
      "alpha",
      "beta",
      "alpha beta",
      "alpha far beta",
    ]);
  });
});
