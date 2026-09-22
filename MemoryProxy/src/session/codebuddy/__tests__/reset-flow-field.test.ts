/**
 * Regression guard for the `resetFlow` field on the CodeBuddy
 * `SessionInitResult`.
 *
 * `claude-code/init.ts` declares `resetFlow?: boolean` on its own
 * `SessionInitResult`, but the CodeBuddy twin — re-exported through
 * `session/index.ts` as the union member every handler consumes — did not.
 * Three handlers read `initResult.resetFlow` to decide whether a
 * `mem:session-reset` flow should emit a confirmation response:
 *
 *   - src/handler.ts:985 / :1099
 *   - src/anthropicHandler.ts:868 / :979
 *   - src/codexHandler.ts:600 / :683
 *
 * Without the field those reads are structurally absent, and every
 * `resetFlow: ...` return literal in `codebuddy/init.ts` is an excess
 * property (TS2353) — 21 errors on that file alone before the fix.
 *
 * The checks below are deliberately type-level: an optional property that no
 * happy-path test populates cannot be caught by a runtime assertion, but a
 * literal typed as `SessionInitResult` will stop compiling the moment the
 * field disappears again.
 */

import { describe, expect, it } from "vitest";
import type { SessionInitResult } from "../init.js";

describe("CodeBuddy SessionInitResult keeps resetFlow in sync with the ClaudeCode twin", () => {
  it("accepts a resetFlow-only literal (the shape every bypass return site uses)", () => {
    // Compiles only if `resetFlow` is a declared member of the interface.
    const result: SessionInitResult = {
      intercepted: false,
      bypassed: true,
      justRegistered: true,
      resetFlow: false,
    };

    expect(result.resetFlow).toBe(false);
  });

  it("treats resetFlow as optional, matching the claude-code twin", () => {
    const withoutField: SessionInitResult = { intercepted: true };
    const withField: SessionInitResult = { intercepted: true, resetFlow: true };

    expect(withoutField.resetFlow).toBeUndefined();
    expect(withField.resetFlow).toBe(true);
  });
});
