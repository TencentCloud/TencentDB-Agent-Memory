/**
 * Tests for #521 — offload.dataDir must be an absolute path; empty / relative
 * values are treated as omitted so offload data never lands under the CWD.
 */

import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig offload.dataDir (#521)", () => {
  it("treats an empty offload.dataDir as omitted", () => {
    expect(parseConfig({ offload: { dataDir: "" } }).offload.dataDir).toBeUndefined();
  });

  it("treats a relative offload.dataDir as omitted", () => {
    expect(parseConfig({ offload: { dataDir: "relative-root" } }).offload.dataDir).toBeUndefined();
  });

  it("keeps an absolute offload.dataDir (POSIX)", () => {
    const cfg = parseConfig({ offload: { dataDir: "/abs/offload" } });
    expect(cfg.offload.dataDir).toBe("/abs/offload");
  });

  it("keeps an absolute offload.dataDir (Windows drive)", () => {
    const cfg = parseConfig({ offload: { dataDir: "C:\\offload\\data" } });
    expect(cfg.offload.dataDir).toBe("C:\\offload\\data");
  });

  it("defaults to undefined when offload.dataDir is not set", () => {
    expect(parseConfig({}).offload.dataDir).toBeUndefined();
  });
});
