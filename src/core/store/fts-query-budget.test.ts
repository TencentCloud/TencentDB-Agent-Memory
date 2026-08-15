import { afterEach, describe, expect, it } from "vitest";

import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
} from "./sqlite.js";

describe("buildFtsQuery query budget", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("deduplicates fallback tokens while preserving first-seen order", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha beta alpha beta gamma")).toBe(
      '"alpha" OR "beta" OR "gamma"',
    );
  });

  it("caps fallback output at 64 unique tokens", () => {
    _setJiebaForTest(null);
    const raw = Array.from({ length: 100 }, (_, index) => `term${index}`).join(" ");

    const query = buildFtsQuery(raw);
    const terms = query?.split(" OR ") ?? [];

    expect(terms).toHaveLength(64);
    expect(terms[0]).toBe('"term0"');
    expect(terms[63]).toBe('"term63"');
    expect(query).not.toContain('"term64"');
  });

  it("applies the same cap to tokenizer output", () => {
    _setJiebaForTest({
      cutForSearch: () => Array.from({ length: 100 }, (_, index) => `token${index}`),
    });

    const terms = buildFtsQuery("ignored")?.split(" OR ") ?? [];

    expect(terms).toHaveLength(64);
    expect(terms[0]).toBe('"token0"');
    expect(terms[63]).toBe('"token63"');
  });

  it("deduplicates tokenizer output before spending the token budget", () => {
    _setJiebaForTest({
      cutForSearch: () => [
        ...Array.from({ length: 100 }, () => "repeated"),
        ...Array.from({ length: 70 }, (_, index) => `unique${index}`),
      ],
    });

    const terms = buildFtsQuery("ignored")?.split(" OR ") ?? [];

    expect(terms).toHaveLength(64);
    expect(terms[0]).toBe('"repeated"');
    expect(terms[63]).toBe('"unique62"');
  });
});
