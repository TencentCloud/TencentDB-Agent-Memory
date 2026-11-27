// Time-filter inputs must be validated before they reach the store/SQLite filter
// (#1492 review, kvnloo): the request schemas accepted any string, so garbage
// (or a non-string like a raw millisecond number) became `new Date(x).getTime()`
// → NaN inside the handler, which silently compared false against every row
// instead of reporting a bad request.
//
// The check is "parseable as a date/time" rather than a strict ISO datetime:
// existing callers legitimately pass date-only strings ("2026-09-01"), and the
// OpenAPI-generated schemas (z.iso.datetime()) would start rejecting those.
// Garbage in → 400 out; previously-valid inputs keep working.
import { describe, expect, it } from "vitest";
import {
  conversationCountRequestSchema,
  atomicCountRequestSchema,
  conversationSessionsRequestSchema,
} from "./v2-schemas.js";

const schemas = [
  ["conversationCountRequestSchema", conversationCountRequestSchema],
  ["atomicCountRequestSchema", atomicCountRequestSchema],
  ["conversationSessionsRequestSchema", conversationSessionsRequestSchema],
] as const;

describe("time_start / time_end validation (#1492 review)", () => {
  for (const [name, schema] of schemas) {
    describe(name, () => {
      it("rejects garbage strings instead of letting NaN reach the filter", () => {
        for (const bad of ["not-a-date", "2026-13-45T99:99:99Z", "", "   ", "1756000000000"]) {
          const r = schema.safeParse({ time_start: bad });
          expect(r.success, `${name} must reject time_start=${JSON.stringify(bad)}`).toBe(false);
        }
        const rEnd = schema.safeParse({ time_end: "tomorrow" });
        expect(rEnd.success, `${name} must reject time_end="tomorrow"`).toBe(false);
      });

      it("accepts the shapes real callers use", () => {
        const ok = [
          "2026-09-28T01:23:45.678Z", // panel: new Date().toISOString()
          "2026-09-27T17:00:00+08:00", // explicit offset
          "2026-09-01", // date-only, previously accepted
        ];
        for (const good of ok) {
          expect(schema.safeParse({ time_start: good }).success, `${name} must accept ${good}`).toBe(true);
        }
      });

      it("stays optional (omitted filters remain valid)", () => {
        expect(schema.safeParse({}).success).toBe(true);
      });
    });
  }
});
