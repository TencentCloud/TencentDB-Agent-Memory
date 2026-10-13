import { expect, it } from "vitest";
import { buildPipelineTimerMember as build, parsePipelineTimerMember as parse } from "../src/core/state/timer-member.js";
import { LocalStateBackend } from "../src/core/state/local-backend.js";
it.each(["teamId", "agentId"] as const)("preserves a partial %s context instead of merging timer identities", field => {
  const a = build("session", "L1_idle", { [field]: "first" });
  const b = build("session", "L1_idle", { [field]: "second" });
  expect(a).not.toBe(b); expect(parse(a)).toMatchObject({ sessionId: "session", [field]: "first" });
});
it("distinguishes explicit empty identities from omitted identities", () => {
  const explicit = build("session", "L2_schedule", { teamId: "", agentId: "" });
  expect(explicit).not.toBe(build("session", "L2_schedule"));
  expect(parse(explicit)).toMatchObject({ teamId: "", agentId: "", taskType: "L2" });
});
it("round-trips a session that looks like scoped timer syntax without injecting a tenant", () => {
  const session = "scope:team:other|agent:other|session:foreign";
  const parsed = parse(build(session, "L1_idle"));
  expect(parsed.sessionId).toBe(session); expect(parsed.teamId).toBeUndefined(); expect(parsed.agentId).toBeUndefined();
});
it("preserves punctuation/unicode and all ordinary timer classifications", () => {
  for (const [timer, type, priority] of [["L1_idle", "L1", 0], ["L2_schedule", "L2", 1], ["L3_schedule", "L3", 2], ["custom", "flush", 0]] as const) {
    expect(parse(build("session:|%世界", timer, { teamId: "team:|%", agentId: "agent:|%" }))).toEqual({ sessionId: "session:|%世界", timerType: timer, taskType: type, priority, teamId: "team:|%", agentId: "agent:|%" });
  }
});
it("retains legacy unscoped/scoped/profile decoding and profile inference", () => {
  expect(parse("session:with:colon:L1_idle")).toMatchObject({ sessionId: "session:with:colon", taskType: "L1" });
  expect(parse("scope:team:team%3Apart|agent:agent|session:session%3Apart:L2_schedule")).toMatchObject({ teamId: "team:part", agentId: "agent", sessionId: "session:part", taskType: "L2" });
  const profile = "profile:team:team|agent:agent|session:source";
  expect(parse(build(profile, "L3_schedule"))).toMatchObject({ sessionId: profile, teamId: "team", agentId: "agent", taskType: "L3" });
});
it("retains both partial-context timers in the actual local backend", async () => {
  const backend = new LocalStateBackend();
  try {
    await backend.setTimer("i", build("session", "L1_idle", { teamId: "first" }), 100);
    await backend.setTimer("i", build("session", "L1_idle", { teamId: "second" }), 100);
    expect((await backend.getExpiredTimers("i", 100)).map(x => parse(x.member).teamId).sort()).toEqual(["first", "second"]);
  } finally { await backend.destroy(); }
});

it.each(["L1_idle:other", "", "L2|other", "L3_世界"])("rejects an invalid new timer label rather than changing parsed identity: %s", label => {
  expect(() => build("session", label, { teamId: "team", agentId: "agent" })).toThrow("Invalid pipeline timer type");
});
