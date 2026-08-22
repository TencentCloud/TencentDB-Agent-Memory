import { describe, it, expect } from "vitest";
import { SessionStore } from "../store.js";
import type { PresetIdentity } from "../preset.js";

/**
 * SessionStore.getOrRecover — preset-identity deferral on a cache/binding miss.
 *
 * Bug context: on a binding/cache miss, getOrRecover fell to tryHistoryScan,
 * which only recognizes interactive picker *form markers*. Header-identity
 * agents (e.g. Pi) carry identity in x-team-id/x-agent-id/x-task-id headers
 * and never produce form markers, so tryHistoryScan returned a `bypassed`
 * state. Because getOrRecover runs BEFORE handleSessionInit in both the
 * OpenAI and Anthropic handlers, the handler then saw bypassed=true and
 * skipped ALL injection — so header-identity sessions got no memory at all.
 *
 * Fix: when a presetIdentity (parsed from headers) is present, defer to
 * handleSessionInit (the headerAutoSelect path) by returning undefined,
 * instead of bypassing via history-scan.
 */
describe("SessionStore.getOrRecover — preset identity deferral", () => {
  // Conversation with history but no form markers — the exact shape that
  // triggers "one-shot bypass (conversation exists but no form markers found)"
  // in the current tryHistoryScan code.
  const historyNoMarkers = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
    { role: "user", content: "another turn" },
  ];
  const identity = {
    userId: "u1",
    agentSource: "pi",
    sessionId: "sess-1",
    spaceId: "default",
  };

  it("preserves current behavior: bypasses on a miss WITHOUT preset identity", async () => {
    const store = new SessionStore(); // no repo, no bindingRepo → history-scan
    const state = await store.getOrRecover("pi:sess-1", identity, {
      messages: historyNoMarkers,
    });
    expect(state).toBeDefined();
    expect(state?.bypassed).toBe(true);
    expect(state?.agentDetail).toBeFalsy();
  });

  it("defers to handleSessionInit (returns undefined) when preset identity is present", async () => {
    const store = new SessionStore();
    const preset: PresetIdentity = {
      teamId: "team-x",
      agentId: "agt-y",
      taskId: "task-z",
    };
    const state = await store.getOrRecover("pi:sess-2", identity, {
      messages: historyNoMarkers,
      presetIdentity: preset,
    });
    expect(state).toBeUndefined();
  });

  it("still returns undefined for a truly fresh session (1 user msg, no history)", async () => {
    const store = new SessionStore();
    const state = await store.getOrRecover("pi:sess-3", identity, {
      messages: [{ role: "user", content: "first msg" }],
    });
    expect(state).toBeUndefined();
  });

  it("preset identity defers even when there is no message history", async () => {
    const store = new SessionStore();
    const preset: PresetIdentity = { teamId: "team-x", agentId: "agt-y" };
    const state = await store.getOrRecover("pi:sess-4", identity, {
      messages: [],
      presetIdentity: preset,
    });
    expect(state).toBeUndefined();
  });
});
