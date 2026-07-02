import { describe, expect, it } from "vitest";
import { buildFtsQuery, quoteFts5Phrase } from "./sqlite.js";

describe("quoteFts5Phrase", () => {
  it("wraps a token as an FTS5 phrase", () => {
    expect(quoteFts5Phrase("hello")).toBe('"hello"');
  });

  it("escapes embedded double quotes by doubling them", () => {
    expect(quoteFts5Phrase('foo"bar')).toBe('"foo""bar"');
  });

  it("keeps FTS5 operators as phrase text", () => {
    expect(quoteFts5Phrase("AND")).toBe('"AND"');
    expect(quoteFts5Phrase("NOT")).toBe('"NOT"');
    expect(quoteFts5Phrase("NEAR")).toBe('"NEAR"');
  });
});

describe("buildFtsQuery", () => {
  it("returns null for empty or punctuation-only input", () => {
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery("!!! ((( )))")).toBeNull();
  });

  it("quotes normal tokens and joins them with controlled OR", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" OR "world"');
  });

  it("treats FTS5 boolean operators as quoted user text tokens", () => {
    expect(buildFtsQuery("foo OR bar NOT baz AND qux")).toBe(
      '"foo" OR "OR" OR "bar" OR "NOT" OR "baz" OR "AND" OR "qux"',
    );
  });

  it("does not preserve punctuation as executable FTS5 syntax", () => {
    expect(buildFtsQuery("NEAR(foo bar) title:baz qux*")).toBe(
      '"NEAR" OR "foo" OR "bar" OR "title" OR "baz" OR "qux"',
    );
  });
});
