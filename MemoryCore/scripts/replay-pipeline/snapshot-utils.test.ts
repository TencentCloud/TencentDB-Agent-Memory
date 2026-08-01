import { describe, expect, it } from "vitest";

import { contentDigest } from "./snapshot-utils.js";

describe("contentDigest", () => {
  it("detects different Persona content with the same length", () => {
    expect("Alice likes Go".length).toBe("Alice likes JS".length);
    expect(contentDigest("Alice likes Go")).not.toBe(contentDigest("Alice likes JS"));
  });
});
