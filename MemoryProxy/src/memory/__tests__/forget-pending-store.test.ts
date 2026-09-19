import { describe, expect, it, vi } from "vitest";
import { ForgetPendingStore, type ForgetTarget } from "../forget-pending-store.js";

const target: ForgetTarget = {
  key: "opaque-key",
  kind: "skill",
  id: "skill-1",
  name: "deploy-check",
  teamId: "team-a",
  agentId: "agent-a",
  preview: "redacted preview",
  detail: "version 3",
  impact: "Deletes all versions.",
};

describe("ForgetPendingStore", () => {
  it("cancel consumes a pending action without executing it", async () => {
    const store = new ForgetPendingStore({ createId: () => "action-1" });
    const execute = vi.fn(async () => ({ kind: target.kind, name: target.name }));
    const actionId = store.prepare("session-a", target);

    expect(store.cancel(actionId, "session-a")).toBe("cancelled");
    await expect(store.confirm(actionId, "session-a", execute)).rejects.toThrow("cancelled");
    expect(execute).not.toHaveBeenCalled();
  });

  it("sequential double-confirm executes deletion once", async () => {
    const store = new ForgetPendingStore({ createId: () => "action-1" });
    const execute = vi.fn(async () => ({ kind: target.kind, name: target.name }));
    const actionId = store.prepare("session-a", target);

    const first = await store.confirm(actionId, "session-a", execute);
    const second = await store.confirm(actionId, "session-a", execute);

    expect(first.alreadyCompleted).toBe(false);
    expect(second.alreadyCompleted).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("concurrent double-confirm shares one in-flight deletion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new ForgetPendingStore({ createId: () => "action-1" });
    const execute = vi.fn(async () => {
      await gate;
      return { kind: target.kind, name: target.name };
    });
    const actionId = store.prepare("session-a", target);

    const first = store.confirm(actionId, "session-a", execute);
    const second = store.confirm(actionId, "session-a", execute);
    release();
    await Promise.all([first, second]);

    expect(execute).toHaveBeenCalledOnce();
  });

  it("expires unconfirmed actions", async () => {
    let now = 1_000;
    const store = new ForgetPendingStore({ ttlMs: 50, now: () => now, createId: () => "action-1" });
    const execute = vi.fn(async () => ({ kind: target.kind, name: target.name }));
    const actionId = store.prepare("session-a", target);
    now += 51;

    await expect(store.confirm(actionId, "session-a", execute)).rejects.toThrow("missing or expired");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not blindly retry an ambiguous failed deletion", async () => {
    const store = new ForgetPendingStore({ createId: () => "action-1" });
    const execute = vi.fn(async () => { throw new Error("socket closed"); });
    const actionId = store.prepare("session-a", target);

    await expect(store.confirm(actionId, "session-a", execute)).rejects.toThrow("outcome is uncertain");
    await expect(store.confirm(actionId, "session-a", execute)).rejects.toThrow("outcome is uncertain");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not allow another session to use an action id", async () => {
    const store = new ForgetPendingStore({ createId: () => "action-1" });
    const execute = vi.fn(async () => ({ kind: target.kind, name: target.name }));
    const actionId = store.prepare("session-a", target);

    await expect(store.confirm(actionId, "session-b", execute)).rejects.toThrow("missing or expired");
    expect(execute).not.toHaveBeenCalled();
  });
});
