import { describe, expect, it, vi } from "vitest";
import { SkillRestructureRecovery } from "./skill-restructure-recovery.js";

describe("bounded pending-operation recovery scheduling", () => {
  it("uses fresh service handles, carries page cursors, and rotates through instances", async () => {
    const pages: Array<[string, string | undefined]> = [];
    const resolve = vi.fn(async (instance: string) => ({ requeuePending: async ({ after }: { after?: string }) => {
      pages.push([instance, after]);
      return { enqueued: 1, next: after ? undefined : `${instance}-next` };
    } }));
    const recovery = new SkillRestructureRecovery({ resolve, maxInstancesPerTick: 1, logger: { warn: vi.fn() } });
    recovery.register("a"); recovery.register("b"); recovery.start();
    await recovery.tick();
    await recovery.tick();
    await recovery.tick();
    await recovery.stop();
    expect(pages).toEqual([["a", undefined], ["b", undefined], ["a", "a-next"]]);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("does not overlap scans and awaits the current scan on shutdown", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const requeuePending = vi.fn(async () => { await pending; return { enqueued: 0 }; });
    const recovery = new SkillRestructureRecovery({ resolve: async () => ({ requeuePending }), logger: { warn: vi.fn() } });
    recovery.register("instance"); recovery.start();
    const first = recovery.tick(), second = recovery.tick();
    await vi.waitFor(() => expect(requeuePending).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stop = recovery.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await Promise.all([first, second, stop]);
    await recovery.tick();
    expect(requeuePending).toHaveBeenCalledTimes(1);
  });

  it("retains the cursor after transient failures and forgets removed instances", async () => {
    const warn = vi.fn();
    const requeuePending = vi.fn().mockRejectedValueOnce(new Error("metadata unavailable"))
      .mockResolvedValue({ enqueued: 0, next: "later" });
    const recovery = new SkillRestructureRecovery({ resolve: async () => ({ requeuePending }), logger: { warn } });
    recovery.register("instance"); recovery.start(); await recovery.tick(); await recovery.tick();
    expect(requeuePending.mock.calls.map(([args]) => args.after)).toEqual([undefined, undefined]);
    expect(warn).toHaveBeenCalledTimes(1);
    recovery.forget("instance"); await recovery.tick(); await recovery.stop();
    expect(requeuePending).toHaveBeenCalledTimes(2);
  });
});
