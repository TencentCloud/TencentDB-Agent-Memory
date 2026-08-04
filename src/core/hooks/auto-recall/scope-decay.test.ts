/**
 * Unit tests for scopeDecayMultiplier — per-project scope-aware score decay.
 * Covers all edge cases from the architect spec.
 */
import { describe, expect, it } from "vitest";
import { scopeDecayMultiplier } from "./scope-decay.js";

const cfg = (overrides: Partial<{ crossProjectDecay: number; defaultCrossProjectMultiplier: number; projectMap: Record<string, number> }> = {}) => ({
  crossProjectDecay: 0.5,
  defaultCrossProjectMultiplier: 0.5,
  projectMap: {},
  ...overrides,
});

describe("scopeDecayMultiplier — edge cases", () => {
  it("empty query projectId → 1.0 (no filter context)", () => {
    expect(scopeDecayMultiplier({ scope: "project", project_id: "/a" }, "", cfg())).toBe(1.0);
  });

  it("missing cfg → 1.0 (defensive)", () => {
    expect(scopeDecayMultiplier({ scope: "project", project_id: "/a" }, "/a", undefined)).toBe(1.0);
  });

  it("global scope → 1.0 (always visible)", () => {
    expect(scopeDecayMultiplier({ scope: "global", project_id: "" }, "/q", cfg())).toBe(1.0);
  });

  it("legacy record (no scope) → 1.0", () => {
    expect(scopeDecayMultiplier({}, "/q", cfg())).toBe(1.0);
  });

  it("exact project match → 1.0", () => {
    expect(scopeDecayMultiplier({ scope: "project", project_id: "/home/penis" }, "/home/penis", cfg())).toBe(1.0);
  });

  it("data anomaly (scope=project, empty project_id) → defaultCrossProjectMultiplier", () => {
    expect(scopeDecayMultiplier({ scope: "project", project_id: "" }, "/home/penis", cfg({ defaultCrossProjectMultiplier: 0.5 }))).toBe(0.5);
  });

  it("project_id undefined → treated as empty → default", () => {
    expect(scopeDecayMultiplier({ scope: "project" }, "/home/penis", cfg())).toBe(0.5);
  });

  it("siblings (1 unique path apart) → 1/(1+0.5*2) = 0.5", () => {
    // /home/penis/projects/u24 vs /home/penis/projects/base-extention
    // setA=4 segs, setB=4 segs, shared=3 (home/penis/projects), u=4+4-6=2
    // mult=1/(1+0.5*2)=0.5
    expect(scopeDecayMultiplier(
      { scope: "project", project_id: "/home/penis/projects/u24" },
      "/home/penis/projects/base-extention",
      cfg(),
    )).toBeCloseTo(0.5, 5);
  });

  it("parent-child (record at root, query is leaf) → 1/(1+0.5*2) = 0.5", () => {
    // /home/penis (root, 2 segs) vs /home/penis/projects/u24 (4 segs)
    // shared=2 (home/penis), u=2+4-4=2; mult=0.5
    expect(scopeDecayMultiplier(
      { scope: "project", project_id: "/home/penis" },
      "/home/penis/projects/u24",
      cfg(),
    )).toBeCloseTo(0.5, 5);
  });

  it("unrelated projects (no shared segs) → defaultMult as floor (0.5)", () => {
    // /cosmic/comp (2 segs) vs /tdai/memory (2 segs); shared=0; u=2+2=4; mult=1/3≈0.333
    // defaultMult=0.5 acts as floor (too unrelated → cap at default).
    expect(scopeDecayMultiplier(
      { scope: "project", project_id: "/cosmic/comp" },
      "/tdai/memory",
      cfg(),
    )).toBeCloseTo(0.5, 5);
  });

  it("projectMap exact match → returns mapped value", () => {
    expect(scopeDecayMultiplier(
      { scope: "project", project_id: "/cosmic/comp" },
      "/cosmic/other",
      cfg({ projectMap: { "/cosmic/comp": 0.8 } }),
    )).toBe(0.8);
  });

  it("projectMap ancestor walk (leaf→root) returns first match", () => {
    // /cosmic/comp/sub hits /cosmic (ancestor) → 0.7
    expect(scopeDecayMultiplier(
      { scope: "project", project_id: "/cosmic/comp/sub" },
      "/tdai/memory",
      cfg({ projectMap: { "/cosmic": 0.7 } }),
    )).toBe(0.7);
  });

  it("projectMap __root__ matches any record without ancestor match", () => {
    expect(scopeDecayMultiplier(
      { scope: "project", project_id: "/cosmic/comp" },
      "/tdai/memory",
      cfg({ projectMap: { __root__: 0.42 } }),
    )).toBe(0.42);
  });

  it("clamp negative multiplier to 0", () => {
    // decay=10 with huge u → tiny; then defaultMult=max(saved, 0.5)=0.5
    expect(scopeDecayMultiplier(
      { scope: "project", project_id: "/a" },
      "/q",
      cfg({ crossProjectDecay: 10, defaultCrossProjectMultiplier: 0.5 }),
    )).toBe(0.5);
  });

  it("clamp oversized multiplier to 1", () => {
    // projectMap with 1.5 → clamp to 1
    expect(scopeDecayMultiplier(
      { scope: "project", project_id: "/a" },
      "/q",
      cfg({ projectMap: { "/a": 1.5 } }),
    )).toBe(1);
  });
});
