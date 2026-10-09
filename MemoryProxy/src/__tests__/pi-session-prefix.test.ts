// Regression for #1424: the Pi provider registers sessions in SessionStore under
// the composite key `pi:<sessionId>`, but the Skill Bridge and Memory Bridge L1
// resolvers only probed the bare id, `codebuddy:` and `claude-code:` — so an
// already-initialized Pi session was invisible to bridge lookups.
import { describe, expect, it } from "vitest";
import { sessionIdCandidatesL1 as memoryCandidates } from "../memory/memory-bridge.js";
import { sessionIdCandidatesL1 as skillCandidates } from "../skill/skill-bridge.js";

describe("sessionIdCandidatesL1 probes the Pi composite key (#1424)", () => {
  for (const [name, fn] of [["memory bridge", memoryCandidates], ["skill bridge", skillCandidates]] as const) {
    describe(name, () => {
      it("bare session id → includes pi:<id> alongside the existing prefixes", () => {
        const c = fn("sess-1");
        expect(c).toContain("sess-1");
        expect(c).toContain("codebuddy:sess-1");
        expect(c).toContain("claude-code:sess-1");
        expect(c, `${name} 必须探测 pi: 前缀`).toContain("pi:sess-1");
      });

      it("an id that already carries a prefix is probed verbatim", () => {
        expect(fn("pi:sess-1")).toEqual(["pi:sess-1"]);
        expect(fn("codebuddy:sess-1")).toEqual(["codebuddy:sess-1"]);
      });
    });
  }
});
