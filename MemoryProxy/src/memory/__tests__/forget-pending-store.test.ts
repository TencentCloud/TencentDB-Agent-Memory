import { describe, expect, it, vi } from "vitest";
import { ForgetPendingStore, type ForgetTarget } from "../forget-pending-store.js";

const target: ForgetTarget = {
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
  it("sequential double-confirm executes deletion once", async () => {
    const store = new ForgetPendingStore({ createId: () => "action-1" });
    const execute = vi.fn(async () => undefined);
    const actionId = store.prepare("session-a", target);

    await store.confirm(actionId, "session-a", execute);
    await store.confirm(actionId, "session-a", execute);

    expect(execute).toHaveBeenCalledOnce();
  });

  it("concurrent double-confirm shares one in-flight deletion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new ForgetPendingStore({ createId: () => "action-1" });
    const execute = vi.fn(async () => {
      await gate;
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
    const execute = vi.fn(async () => undefined);
    const actionId = store.prepare("session-a", target);
    now += 51;

    await expect(store.confirm(actionId, "session-a", execute)).rejects.toThrow("missing or expired");
    expect(execute).not.toHaveBeenCalled();
  });

  it("deletes a failed action and requires a fresh preview", async () => {
    const store = new ForgetPendingStore({ createId: () => "action-1" });
    const execute = vi.fn(async () => { throw new Error("socket closed"); });
    const actionId = store.prepare("session-a", target);

    await expect(store.confirm(actionId, "session-a", execute)).rejects.toThrow("run a fresh preview");
    await expect(store.confirm(actionId, "session-a", execute)).rejects.toThrow("missing or expired");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not allow another session to use an action id", async () => {
    const store = new ForgetPendingStore({ createId: () => "action-1" });
    const execute = vi.fn(async () => undefined);
    const actionId = store.prepare("session-a", target);

    await expect(store.confirm(actionId, "session-b", execute)).rejects.toThrow("missing or expired");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps multiple actions from the same session independent", async () => {
    let id = 0;
    const store = new ForgetPendingStore({ createId: () => `action-${++id}` });
    const execute = vi.fn(async (_item: ForgetTarget) => undefined);
    const first = store.prepare("session-a", target);
    const secondTarget = { ...target, id: "skill-2", name: "release-check" };
    const second = store.prepare("session-a", secondTarget);

    await store.confirm(first, "session-a", execute);
    await store.confirm(second, "session-a", execute);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, target);
    expect(execute).toHaveBeenNthCalledWith(2, secondTarget);
  });
});
