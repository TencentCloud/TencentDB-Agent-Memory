import { describe, it, expect } from "vitest";
import { isSceneBlockRelPath, isAddressableBlockPath, isSceneBlockRelPathOrPersona } from "./block-paths.js";

describe("block-paths (single addressable-path authority)", () => {
  it("accepts valid scene block rel paths", () => {
    expect(isSceneBlockRelPath("scene_blocks/_global/ok.md")).toBe(true);
    expect(isSceneBlockRelPath("scene_blocks/penis-d5b6cacf/технический-отчет.md")).toBe(true); // Unicode
    expect(isSceneBlockRelPath("scene_blocks/a/b.md")).toBe(true);
  });

  it("rejects traversal / absolute / tilde / empty", () => {
    expect(isSceneBlockRelPath("")).toBe(false);
    expect(isSceneBlockRelPath("scene_blocks/../etc/passwd")).toBe(false);
    expect(isSceneBlockRelPath("scene_blocks/_global/../../etc/passwd")).toBe(false);
    expect(isSceneBlockRelPath("/etc/passwd")).toBe(false);
    expect(isSceneBlockRelPath("~/x.md")).toBe(false);
    expect(isSceneBlockRelPath("scene_blocks")).toBe(false);
    expect(isSceneBlockRelPath("scene_blocks/_global")).toBe(false);
  });

  it("rejects wrong roots / nesting / non-md", () => {
    expect(isSceneBlockRelPath("other/x/y.md")).toBe(false);
    expect(isSceneBlockRelPath("scene_blocks/a/b/c.md")).toBe(false); // nesting
    expect(isSceneBlockRelPath("scene_blocks/a/b.txt")).toBe(false);
    expect(isSceneBlockRelPath("scene_blocks//b.md")).toBe(false);
  });

  it("isAddressableBlockPath: scene blocks + persona.md only", () => {
    expect(isAddressableBlockPath("persona.md")).toBe(true);
    expect(isAddressableBlockPath("scene_blocks/_global/ok.md")).toBe(true);
    expect(isAddressableBlockPath("memory_health.md")).toBe(false);
    expect(isAddressableBlockPath("records/x.jsonl")).toBe(false);
    expect(isAddressableBlockPath("scene_blocks/a")).toBe(false);
  });

  it("isSceneBlockRelPathOrPersona matches the apply-side predicate (persona special-case)", () => {
    expect(isSceneBlockRelPathOrPersona("persona.md")).toBe(true);
    expect(isSceneBlockRelPathOrPersona("scene_blocks/_global/технический-отчет.md")).toBe(true);
    expect(isSceneBlockRelPathOrPersona("memory_health.md")).toBe(false);
    expect(isSceneBlockRelPathOrPersona("../../etc/passwd")).toBe(false);
  });
});
