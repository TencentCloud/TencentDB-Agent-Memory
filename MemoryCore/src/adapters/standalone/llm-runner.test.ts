import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSandboxedPath } from "./llm-runner.js";

describe("standalone LLM file-tool sandbox", () => {
  it("rejects parent traversal into a sibling with the same path prefix", () => {
    const workspace = path.resolve("persona-draft-root");
    expect(resolveSandboxedPath(workspace, "persona.md"))
      .toBe(path.join(workspace, "persona.md"));
    expect(resolveSandboxedPath(workspace, "../persona-draft-root-escape/persona.md"))
      .toBeNull();
    expect(resolveSandboxedPath(workspace, "../persona-draft-root/persona.md"))
      .toBe(path.join(workspace, "persona.md"));
  });
});
