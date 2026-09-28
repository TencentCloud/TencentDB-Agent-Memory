import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json" with { type: "json" };
import OpenCodeMemoryPlugin, { memoryTencentDbOpenCodePlugin } from "./index.js";

describe("OpenCode plugin entry", () => {
  it("exports only aliases of the loadable plugin function", async () => {
    const entry = await import("./index.js");

    expect(OpenCodeMemoryPlugin).toBe(memoryTencentDbOpenCodePlugin);
    expect(Object.values(entry).every((value) => typeof value === "function")).toBe(true);
    expect(new Set(Object.values(entry)).size).toBe(1);
  });

  it("declares the OpenCode server plugin entry in the package manifest", () => {
    expect(packageJson.exports["./server"]).toEqual({
      import: "./dist/opencode.mjs",
      default: "./dist/opencode.mjs",
    });
  });
});