import { describe, expect, it } from "vitest";
import { PiProfile, splitByPiLabels, applyPiAnchor } from "../profile.js";

/**
 * Pi wraps project instructions inside nested XML blocks
 * (<project_context> → <project_instructions path="...">), and those files
 * routinely contain label-shaped lines of their own ("Guidelines:", "Never:").
 * Those lines are body text, not sections.
 */
const SYSTEM_WITH_NESTED_LABELS = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "",
  "Available tools:",
  "- read",
  "",
  "Guidelines:",
  "- Be concise in your responses",
  "",
  "<project_context>",
  "",
  "Project-specific instructions and guidelines:",
  "",
  '<project_instructions path="/repo/AGENTS.md">',
  "# Repo rules",
  "",
  "Guidelines:",
  "- Follow existing patterns.",
  "- Never commit secrets.",
  "</project_instructions>",
  "",
  "</project_context>",
  "",
].join("\n");

describe("splitByPiLabels", () => {
  it("does not open a section on a label-shaped line nested in an XML block", () => {
    const keys = splitByPiLabels(SYSTEM_WITH_NESTED_LABELS).map((s) => s.key);

    expect(keys).toEqual([null, "Available tools", "Guidelines", "project_context"]);
    expect(keys.filter((k) => k === "Guidelines")).toHaveLength(1);
  });

  it("keeps parse -> rebuild lossless", () => {
    const profile = new PiProfile();
    const rebuilt = profile.rebuild(profile.parse(SYSTEM_WITH_NESTED_LABELS));

    expect(rebuilt).toBe(SYSTEM_WITH_NESTED_LABELS);
  });

  it("keeps the nested instructions inside the enclosing project_context section", () => {
    const segs = splitByPiLabels(SYSTEM_WITH_NESTED_LABELS);
    const projectContext = segs.find((s) => s.key === "project_context");

    expect(projectContext?.rawText).toContain('<project_instructions path="/repo/AGENTS.md">');
    expect(projectContext?.rawText).toContain("- Never commit secrets.");
  });

  it("still splits on labels at depth zero", () => {
    const keys = splitByPiLabels(
      ["Available tools:", "- read", "", "Guidelines:", "- be nice"].join("\n"),
    ).map((s) => s.key);

    expect(keys).toEqual(["Available tools", "Guidelines"]);
  });

  it("keeps splitting after an unclosed block instead of swallowing later sections", () => {
    // A malformed prompt must not silently drop every later section: with
    // unbalanced tags the parser falls back to its original line-by-line split.
    const keys = splitByPiLabels(
      [
        "Available tools:",
        "- read",
        "",
        "<project_context>",
        "Guidelines:",
        "- nested",
        "",
        "Guidelines:",
        "- top level, never closed above",
      ].join("\n"),
    ).map((s) => s.key);

    expect(keys).toContain("Guidelines");
  });
});

describe("applyPiAnchor", () => {
  it.each(["before", "after", "inside_prepend", "inside_append"] as const)(
    "injects exactly once for relation=%s when a nested label duplicates the key",
    (relation) => {
      const profile = new PiProfile();
      const marker = `<<<injected-${relation}>>>`;
      const segments = profile.parse(SYSTEM_WITH_NESTED_LABELS);
      const rebuilt = profile.rebuild(
        applyPiAnchor(segments, { key: "Guidelines", relation }, marker),
      );

      expect(rebuilt.split(marker)).toHaveLength(2);
      // The block lands on the top-level Guidelines section, never inside the
      // project instructions that merely contain the same label text.
      const markerAt = rebuilt.indexOf(marker);
      const nestedAt = rebuilt.indexOf('<project_instructions path="/repo/AGENTS.md">');
      expect(markerAt).toBeGreaterThan(-1);
      expect(markerAt).toBeLessThan(nestedAt);
    },
  );
});
