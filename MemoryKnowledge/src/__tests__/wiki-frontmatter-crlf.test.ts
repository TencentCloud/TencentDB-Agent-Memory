import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../engines/wiki/ingest-v2/frontmatter.js";
import { __testing } from "../store/wiki-service.js";

const { injectLockedTrue, parseFrontmatterMin } = __testing;

const crlfPage = [
  "---",
  "type: concept",
  "title: CRLF Page",
  "description: Windows-authored content",
  "locked: false",
  "---",
  "Body",
].join("\r\n");

const bomCrlfPage = `\uFEFF${crlfPage}`;

describe("Wiki page frontmatter CRLF handling", () => {
  it("parses CRLF frontmatter metadata", () => {
    expect(parseFrontmatterMin(crlfPage)).toEqual({
      title: "CRLF Page",
      type: "concept",
      description: "Windows-authored content",
      locked: false,
    });
  });

  it("updates locked inside CRLF frontmatter without nesting a second block", () => {
    const result = injectLockedTrue(crlfPage);

    expect(result.lockedInjected).toBe(true);
    expect(result.content.match(/^---/gm)).toHaveLength(2);
    expect(result.content).toContain("\r\nlocked: true\r\n");
    expect(result.content).not.toContain("---\nlocked: true\n---\n---");
    expect(parseFrontmatterMin(result.content)).toEqual({
      title: "CRLF Page",
      type: "concept",
      description: "Windows-authored content",
      locked: true,
    });
  });

  it("appends locked using the existing CRLF style", () => {
    const withoutLocked = [
      "---",
      "type: concept",
      "title: CRLF Page",
      "---",
      "Body",
    ].join("\r\n");

    const result = injectLockedTrue(withoutLocked);

    expect(result.content).toBe([
      "---",
      "type: concept",
      "title: CRLF Page",
      "locked: true",
      "---",
      "Body",
    ].join("\r\n"));
  });

  it("parses UTF-8 BOM plus CRLF frontmatter", () => {
    expect(parseFrontmatterMin(bomCrlfPage)).toEqual({
      title: "CRLF Page",
      type: "concept",
      description: "Windows-authored content",
      locked: false,
    });
    expect(parseFrontmatter(bomCrlfPage)).toMatchObject({
      hasFrontmatter: true,
      body: "Body",
      frontmatter: {
        type: "concept",
        title: "CRLF Page",
        description: "Windows-authored content",
        locked: false,
      },
    });
  });

  it("updates locked in BOM+CRLF frontmatter while preserving the BOM", () => {
    const result = injectLockedTrue(bomCrlfPage);

    expect(result.lockedInjected).toBe(true);
    expect(result.content.startsWith("\uFEFF---\r\n")).toBe(true);
    expect(result.content.slice(1).match(/^---/gm)).toHaveLength(2);
    expect(parseFrontmatterMin(result.content)).toEqual({
      title: "CRLF Page",
      type: "concept",
      description: "Windows-authored content",
      locked: true,
    });
  });
});
