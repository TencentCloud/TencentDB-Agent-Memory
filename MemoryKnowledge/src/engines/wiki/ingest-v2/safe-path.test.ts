import { sep } from "node:path";
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

  it("accepts a root with a trailing separator", () => {
    expect(isInsideRoot("/data/proj/", "/data/proj/wiki/a.md")).toBe(true);
  });

  it("rejects relative candidates resolved against the process cwd", () => {
    expect(isInsideRoot("/data/proj", "wiki/a.md")).toBe(false);
  });

  it("treats backslashes according to the host path separator", () => {
    // On win32 a backslash separates components; on POSIX it is a literal character.
    // Pinning the difference guards the node:path.sep dependency in the implementation.
    expect(isInsideRoot("/data/proj", "/data/proj\\evil/a.md")).toBe(sep === "\\");
  });
});
