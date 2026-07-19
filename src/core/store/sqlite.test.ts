import { describe, expect, it } from "vitest";
import { buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  it("strips FTS5 operators before building an FTS query", () => {
    const query = buildFtsQuery(
      "alpha OR beta AND gamma NOT delta NEAR epsilon",
    );

    expect(query).toBe('"alpha" OR "beta" OR "gamma" OR "delta" OR "epsilon"');
  });
});
