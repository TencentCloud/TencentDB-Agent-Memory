import { expect, it } from "vitest";
import { PipelineWorker } from "../src/services/pipeline-worker.js";
import { LocalStateBackend } from "../src/core/state/local-backend.js";
import type { TaskPayload } from "../src/core/state/types.js";
function task(patch: Partial<TaskPayload> = {}): TaskPayload { return { id: "synthetic", type: "L1", instanceId: "i", sessionId: "s", priority: 0, createdAt: 1, ...patch }; }
function key(t: TaskPayload, mode = "session"): string | null {
  const fn: unknown = Object.getOwnPropertyDescriptor(PipelineWorker.prototype, "getLockKey")?.value;
  if (typeof fn !== "function") throw new Error("Missing lock scope method");
  return fn.call({ config: { lockGranularity: mode } }, t);
}
it.each(["L1", "L2"] as const)("isolates colon-containing team/agent tuples for %s locks", async type => {
  const a = key(task({ type, teamId: "team:part", agentId: "agent" }));
  const b = key(task({ type, teamId: "team", agentId: "part:agent" }));
  expect(a).not.toBe(b); if (!a || !b) throw new Error("Missing lock");
  const backend = new LocalStateBackend();
  try { expect(await backend.acquireLock(a, "owner-a", 1000)).toBe(true); expect(await backend.acquireLock(b, "owner-b", 1000)).toBe(true); } finally { await backend.destroy(); }
});
it("distinguishes omitted identity from a literal underscore", () => {
  expect(key(task())).not.toBe(key(task({ teamId: "_", agentId: "_" })));
});
it("isolates instance/MMD tuples containing lock delimiters", () => {
  expect(key(task({ type: "offload-l2", instanceId: "i}:offload-l2:x", data: { targetMmdFile: "y" } })))
    .not.toBe(key(task({ type: "offload-l2", instanceId: "i", data: { targetMmdFile: "x}:offload-l2:y" } })));
});
it("preserves per-session L1/flush and shared L2/L3 agent exclusion", () => {
  const scoped = task({ teamId: "team", agentId: "agent" });
  expect(key(scoped)).toBe(key({ ...scoped, type: "flush" }));
  expect(key(scoped)).not.toBe(key({ ...scoped, sessionId: "other" }));
  expect(key({ ...scoped, type: "L2" })).toBe(key({ ...scoped, type: "L3", sessionId: "other" }));
});
it("preserves instance granularity and lock-free offload stages", () => {
  expect(key(task(), "instance")).toBe(key(task({ type: "L3", teamId: "other", sessionId: "other" }), "instance"));
  expect(key(task({ type: "offload-l1" }))).toBeNull();
  expect(key(task({ type: "offload-l15" }))).toBeNull();
});
it("preserves legacy data and profile tenant resolution", () => {
  const scoped = key(task({ type: "L2", teamId: "team", agentId: "agent" }));
  expect(key(task({ type: "L2", data: { teamId: "team", agentId: "agent" } }))).toBe(scoped);
  expect(key(task({ type: "L2", sessionId: "profile:team:team|agent:agent|session:source" }))).toBe(scoped);
});
it("keeps braces inside identifiers outside Redis hash-tag syntax", () => {
  const k = key(task({ instanceId: "i}{injected", teamId: "team", agentId: "agent" }));
  expect(k).not.toBeNull(); expect(k!.match(/[{}]/g)).toHaveLength(2);
});

it("rejects a non-string offload target without coercing it into a shared key", () => {
  expect(() => key(task({ type: "offload-l2", data: { targetMmdFile: {} } }))).toThrow("Invalid offload lock target");
});
