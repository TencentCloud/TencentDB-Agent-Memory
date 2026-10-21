import { describe, expect, it } from "vitest";
import { isEmptyListing } from "../injectors/skill-injector.js";

/**
 * Regression guard for the "(none)" substring bug.
 *
 * Real incident (2026-10-13): agent agt-4ran383sx6 owned 20 skills, but one
 * skill's `desc` contained the literal text "…TDB scheduling capability
 * (none)…". The old guard `listing.includes("(none)")` matched that sentence,
 * so a fully populated 5,695-char catalog was discarded and the agent saw
 * zero skills for the whole session. The empty result also short-circuited
 * the hook-cache self-heal, so every turn re-queried core and the KV cache
 * never warmed up (2.4% hit rate, pinned at 186 cached tokens).
 */
describe("isEmptyListing", () => {
  it("treats a missing listing as empty", () => {
    expect(isEmptyListing(undefined)).toBe(true);
    expect(isEmptyListing(null)).toBe(true);
    expect(isEmptyListing("")).toBe(true);
    expect(isEmptyListing("   \n\t ")).toBe(true);
  });

  it("treats core's real no-skill sentinel as empty", () => {
    // What /v3/skill/listing actually returns for an agent owning nothing.
    expect(isEmptyListing("<available_skills>\n(none)\n</available_skills>")).toBe(true);
    expect(isEmptyListing("<available_skills>(none)</available_skills>")).toBe(true);
    expect(isEmptyListing("(none)")).toBe(true);
    expect(isEmptyListing(" (none)\n")).toBe(true);
  });

  it("keeps a real catalog whose skill description mentions (none)", () => {
    const listing = [
      "<available_skills>",
      "# 每行一个 skill",
      "- id=skl-VVpBjzIgQSnM, name=xiaolvshu-graphic-note-writing, desc=老邢要写小绿书",
      "- id=skl-ABC, name=dsh-session-duplication-pattern, desc="
        + "Covers dsh-session duplication pattern, TDB scheduling capability (none), "
        + "and L1 parameter adjustment as a partial workaround.",
      "</available_skills>",
    ].join("\n");

    expect(isEmptyListing(listing)).toBe(false);
  });

  it("keeps a catalog that merely contains the word none in other forms", () => {
    expect(isEmptyListing("<available_skills>\n(none yet)\n</available_skills>")).toBe(false);
    expect(isEmptyListing("<available_skills>\nno skills (none-related)\n</available_skills>")).toBe(false);
  });
});
