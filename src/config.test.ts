import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "./config.js";

describe("parseConfig offload.dataDir", () => {
  it("treats an empty offload.dataDir as omitted", () => {
    expect(parseConfig({ offload: { dataDir: "" } }).offload.dataDir).toBeUndefined();
  });

  it("treats a relative offload.dataDir as omitted", () => {
    expect(parseConfig({ offload: { dataDir: "relative-root" } }).offload.dataDir).toBeUndefined();
  });

  it("preserves an explicit absolute offload.dataDir", () => {
    const absoluteRoot = join(tmpdir(), "memory-tdai-offload");

    expect(parseConfig({ offload: { dataDir: absoluteRoot } }).offload.dataDir).toBe(absoluteRoot);
  });
});
