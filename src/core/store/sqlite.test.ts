import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("strips FTS5 operators from raw input before fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha OR beta AND NOT gamma NEAR delta")).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta"',
    );
  });
});
