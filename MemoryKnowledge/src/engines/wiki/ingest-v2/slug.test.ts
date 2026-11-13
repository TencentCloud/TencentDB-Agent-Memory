import { describe, expect, it } from "vitest";

import { dirForType, pageRelPath, slugify } from "./slug.js";

describe("slugify", () => {
  it("lowercases latin segments and joins tokens with hyphens", () => {
    expect(slugify("Redis Cluster")).toBe("redis-cluster");
  });

  it("keeps CJK characters", () => {
    expect(slugify("Redis 主从")).toBe("redis-主从");
  });

  it("collapses punctuation and repeated separators", () => {
    expect(slugify("  A -- B!! C  ")).toBe("a-b-c");
  });

  it("returns an empty string for empty input", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
  });

  it("is stable across repeated calls", () => {
    expect(slugify("Redis 主从")).toBe(slugify("Redis 主从"));
  });
});

describe("dirForType", () => {
  it("maps known types to their directories", () => {
    expect(dirForType("entity")).toBe("entities");
    expect(dirForType("thesis")).toBe("synthesis");
  });

  it("uses safe unknown types as-is", () => {
    expect(dirForType("custom_type")).toBe("custom_type");
  });

  it("normalizes case and surrounding whitespace before lookup", () => {
    expect(dirForType("Entity")).toBe("entities");
    expect(dirForType("  ENTITY  ")).toBe("entities");
  });

  it("routes unsafe values to other", () => {
    expect(dirForType("../escape")).toBe("other");
    expect(dirForType("has/slash")).toBe("other");
    expect(dirForType("")).toBe("other");
  });

  it("does not resolve prototype-chain keys through the directory map", () => {
    // "__proto__" matches the safe identifier pattern, so it is used as-is.
    // Object.hasOwn in the implementation prevents it from hitting the prototype.
    expect(dirForType("__proto__")).toBe("__proto__");
  });
});

describe("pageRelPath", () => {
  it("builds a wiki-relative markdown path", () => {
    expect(pageRelPath("entity", "Redis Cluster")).toBe("wiki/entities/redis-cluster.md");
  });

  it("keeps an empty slug for a blank title", () => {
    // slugify("") is "", so the path currently ends in ".md" with no stem.
    expect(pageRelPath("entity", "")).toBe("wiki/entities/.md");
  });
});
