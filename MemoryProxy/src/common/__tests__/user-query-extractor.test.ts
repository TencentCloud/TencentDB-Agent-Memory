import { describe, expect, it } from "vitest";
import { isDshPermissionChangeNotice } from "../user-query-extractor.js";

describe("isDshPermissionChangeNotice", () => {
  it("matches the DSH approval-policy notice", () => {
    expect(
      isDshPermissionChangeNotice(
        'The approval policy changed from "ask" to "never" (changed by the user).',
      ),
    ).toBe(true);
  });

  it("ignores leading whitespace like the sibling anchors", () => {
    expect(
      isDshPermissionChangeNotice(
        '  The approval policy changed from "ask" to "never".',
      ),
    ).toBe(true);
  });

  it("does not match real user input", () => {
    expect(isDshPermissionChangeNotice("hi")).toBe(false);
    expect(
      isDshPermissionChangeNotice("The approval policy is confusing, help?"),
    ).toBe(false);
    expect(isDshPermissionChangeNotice("")).toBe(false);
  });
});
