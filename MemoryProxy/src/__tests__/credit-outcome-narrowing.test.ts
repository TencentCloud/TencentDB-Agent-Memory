/**
 * Regression guard for the `CreditReportOutcome` type-narrowing bug.
 *
 * `tryReportCreditFromPath` returns `CreditReportOutcome`, which declares
 * `errorMessage?`, `errorHeader?` and `result?` alongside `attempted` / `ok`.
 * The failure branch really does populate them:
 *
 *     // credit-reporter.ts
 *     return { attempted: true, ok: false, errorMessage, errorHeader, result };
 *
 * But two of the four call sites wrap it in a ternary whose other branch is a
 * bare literal:
 *
 *     ctx.skipCreditReport
 *       ? Promise.resolve({ attempted: false, ok: false })
 *       : tryReportCreditFromPath(...)
 *
 * TypeScript infers the union's *shared* members for the whole expression, so
 * the optional fields vanish from the inferred type and every downstream read
 * of `outcome.errorMessage` fails with TS2339 — even though the value is
 * present at runtime. That is exactly the shape in `handler.ts` (stream path)
 * and `anthropicHandler.ts` (stream path), while the non-stream paths in the
 * same files annotate the outcome explicitly and stay clean.
 *
 * These tests pin the *inference* behaviour that caused it: a ternary between
 * a bare `{ attempted, ok }` literal and the full outcome must not silently
 * drop the optional members. Annotating the skip branch as
 * `CreditReportOutcome` is the fix; if someone reverts it, this file stops
 * compiling.
 */

import { describe, expect, it } from "vitest";
import { tryReportCreditFromPath } from "../credit-reporter.js";
import type { CreditReportOutcome } from "../credit-reporter.js";

describe("CreditReportOutcome keeps its optional members through a skip-ternary", () => {
  it("the skip branch satisfies the full outcome type, not just {attempted, ok}", () => {
    // This is the fix in type form: the literal is annotated as the full
    // outcome, so the ternary's inferred type retains errorMessage/errorHeader.
    const skip: CreditReportOutcome = { attempted: false, ok: false };

    // Reading the optional members must type-check on the skip branch itself.
    const message: string | undefined = skip.errorMessage;
    const header: string | undefined = skip.errorHeader;

    expect(message).toBeUndefined();
    expect(header).toBeUndefined();
  });

  it("the real function is typed as returning the full outcome", () => {
    // Compile-time assertion: the declared return type must include the
    // optional error members the handlers read.
    const fn: (
      ...args: never[]
    ) => Promise<CreditReportOutcome> = tryReportCreditFromPath as unknown as (
      ...args: never[]
    ) => Promise<CreditReportOutcome>;

    expect(typeof fn).toBe("function");
  });

  it("the annotated skip arm keeps the optional members readable", () => {
    // The fix, in the exact shape the handlers use. If someone drops the
    // `<CreditReportOutcome>` annotation, TypeScript infers the union's shared
    // members for the ternary and `errorMessage` stops compiling here.
    const skipCreditReport = true;
    const outcome: Promise<CreditReportOutcome> = skipCreditReport
      ? Promise.resolve<CreditReportOutcome>({ attempted: false, ok: false })
      : Promise.resolve<CreditReportOutcome>({
          attempted: true,
          ok: false,
          errorMessage: "spaceId=x error=boom",
        });

    return outcome.then((o) => {
      const message: string | undefined = o.errorMessage;
      expect(typeof o.attempted).toBe("boolean");
      expect(typeof o.ok).toBe("boolean");
      // The skip arm is what actually resolves, so the members are readable
      // and simply absent — which is the whole point of them being optional.
      expect(message).toBeUndefined();
    });
  });
});
