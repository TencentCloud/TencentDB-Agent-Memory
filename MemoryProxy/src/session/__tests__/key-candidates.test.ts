/**
 * Tests for session-key candidate generation (bridges' L1 probe list).
 *
 * Regression: the bridges used to hard-code `[codebuddy, claude-code]`, so any
 * other client (workbuddy / pi / codex / dsh / opencode) never probed its own
 * composite key → L1 miss → 401 on memory/skill recall. See
 * `src/session/key-candidates.ts`.
 */
import { describe, it, expect } from "vitest";
import { sessionKeyCandidates } from "../key-candidates.js";
import { KNOWN_AGENT_KINDS } from "../../agent-adapters/types.js";
import { resolveAgentAdapter } from "../../agent-adapters/index.js";

describe("sessionKeyCandidates", () => {
  it("tries the bare id first, then every known agent prefix", () => {
    const out = sessionKeyCandidates("conv-abc");
    expect(out[0]).toBe("conv-abc");
    for (const k of KNOWN_AGENT_KINDS) {
      expect(out).toContain(`${k}:conv-abc`);
    }
    // length = bare + one per known agent kind (no duplicates)
    expect(out).toHaveLength(1 + KNOWN_AGENT_KINDS.length);
    expect(new Set(out).size).toBe(out.length);
  });

  it("covers the previously-missing clients (regression guard)", () => {
    const out = sessionKeyCandidates("sid-1");
    for (const k of ["workbuddy", "pi", "codex", "dsh", "opencode"]) {
      expect(out).toContain(`${k}:sid-1`);
    }
  });

  it("returns an already-composite key unchanged (single candidate)", () => {
    expect(sessionKeyCandidates("workbuddy:conv-abc")).toEqual(["workbuddy:conv-abc"]);
    expect(sessionKeyCandidates("claude-code:conv-abc")).toEqual(["claude-code:conv-abc"]);
  });
});

describe("KNOWN_AGENT_KINDS stays in sync with the adapter registry", () => {
  it("has an adapter (not the default) for every known kind", () => {
    // resolveAgentAdapter falls back to defaultAdapter for unknown inputs; a
    // known kind resolving to that fallback means the two lists drifted.
    const fallback = resolveAgentAdapter("__definitely_unknown__");
    for (const k of KNOWN_AGENT_KINDS) {
      const adapter = resolveAgentAdapter(k);
      expect(adapter.agentKind).toBe(k);
      expect(adapter).not.toBe(fallback);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(KNOWN_AGENT_KINDS).size).toBe(KNOWN_AGENT_KINDS.length);
  });
});
