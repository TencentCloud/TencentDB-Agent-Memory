import { describe, expect, it } from "vitest";

import { isInsideRoot } from "./safe-path.js";

describe("isInsideRoot", () => {
  it("accepts the root itself", () => {
    expect(isInsideRoot("/data/proj", "/data/proj")).toBe(true);
  });

  it("accepts nested paths", () => {
    expect(isInsideRoot("/data/proj", "/data/proj/wiki/entities/a.md")).toBe(true);
    expect(isInsideRoot("/data/proj", "/data/proj/./wiki/../wiki/a.md")).toBe(true);
  });

  it("rejects parent traversal", () => {
    expect(isInsideRoot("/data/proj", "/data/proj/../outside/a.md")).toBe(false);
    expect(isInsideRoot("/data/proj", "/data/other/a.md")).toBe(false);
  });

  it("rejects sibling directories sharing a name prefix", () => {
    // A naive startsWith(root) check would wrongly accept this path.
    expect(isInsideRoot("/data/proj", "/data/proj-evil/a.md")).toBe(false);
  });
});
