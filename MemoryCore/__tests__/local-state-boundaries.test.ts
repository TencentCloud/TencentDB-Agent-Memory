import { afterEach, expect, it } from "vitest";
import { LocalStateBackend } from "../src/core/state/local-backend.js";
const stores: LocalStateBackend[] = [];
function store() { const s = new LocalStateBackend(); stores.push(s); return s; }
afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.destroy())); });

it("separates colon-containing team/agent tuples for buffers and state", async () => {
  const s = store();
  await s.appendBuffer("instance", "session", "synthetic private", "team:part", "agent");
  await s.updateSessionState("instance", "session", { last_active_time: 17 }, "team:part", "agent");
  expect(await s.drainBuffer("instance", "session", "team", "part:agent")).toEqual([]);
  expect(await s.getSessionState("instance", "session", "team", "part:agent")).toBeNull();
  expect(await s.drainBuffer("instance", "session", "team:part", "agent")).toEqual(["synthetic private"]);
});
it("distinguishes omitted, empty and literal underscore identities", async () => {
  const s = store(); await s.appendBuffer("i", "s", "legacy");
  expect(await s.drainBuffer("i", "s", "_", "_")).toEqual([]);
  expect(await s.drainBuffer("i", "s", "", "")).toEqual([]);
  expect(await s.drainBuffer("i", "s")).toEqual(["legacy"]);
});
it("lists exact instances and preserves session punctuation", async () => {
  const s = store();
  await s.updateSessionState("i", "session:with:colon", {});
  await s.updateSessionState("i:other", "foreign", {});
  expect(await s.listActiveSessions("i")).toEqual(["session:with:colon"]);
});
it("purges only exact instance sessions, buffers and timers", async () => {
  const s = store();
  for (const i of ["i", "i:other"]) { await s.appendBuffer(i, "s", i); await s.updateSessionState(i, "s", {}); await s.setTimer(i, "timer", 100); }
  expect(await s.purgeInstance("i")).toEqual({ sessions: 1, buffers: 1, timers: 1 });
  expect(await s.drainBuffer("i:other", "s")).toEqual(["i:other"]);
  expect(await s.getSessionState("i:other", "s")).not.toBeNull();
  expect(await s.getExpiredTimers("i:other", 100)).toEqual([{ instanceId: "i:other", member: "timer", fireAtMs: 100 }]);
});
it("keeps colliding timer tuples distinct when removing a timer", async () => {
  const s = store(); await s.setTimer("i:part", "member", 100); await s.setTimer("i", "part:member", 200);
  await s.removeTimer("i", "part:member");
  expect(await s.getExpiredTimers("i:part", 100)).toEqual([{ instanceId: "i:part", member: "member", fireAtMs: 100 }]);
});
it("does not retrieve or reschedule another instance timer through a prefix", async () => {
  const s = store(); await s.setTimer("i:part", "member", 100);
  expect(await s.getExpiredTimers("i", 100)).toEqual([]);
  expect(await s.setTimerIfEarlier("i", "part:member", 200)).toBe(true);
  expect(await s.getExpiredTimers("i:part", 100)).toHaveLength(1);
});
