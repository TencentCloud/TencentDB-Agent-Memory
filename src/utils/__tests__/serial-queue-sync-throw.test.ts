import { describe, expect, it } from "vitest";
import { SerialQueue } from "../serial-queue.js";

describe("SerialQueue — issue #518 sync throw deadlock", () => {
  it(
    "exact #518 reproducer: sync throw + catch does not deadlock the queue for later async tasks",
    async () => {
      const queue = new SerialQueue("repro");

      // Step 1: add a SYNCHRONOUSLY throwing task and swallow the rejection
      await queue
        .add(() => {
          throw new Error("sync failure");
        })
        .catch(() => undefined);

      // Step 2: enqueue a normal async task — without the fix, `this.running`
      // remains true forever (the sync throw happened before .then() chain),
      // so drain() returns early at `if (this.running || ...)` and this task
      // never runs — leading to a 100ms timeout loss.
      const next = queue.add(async () => "ran");

      // Step 3: race against a 100ms timeout (per issue reproducer literal)
      const outcome = await Promise.race([
        next,
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);

      // WITH the fix: outcome = "ran"; without: "timeout"
      expect(outcome).toBe("ran");
    },
    500,
  );

  it("multiple sync-throw tasks in sequence all report their error and later tasks run", async () => {
    const q = new SerialQueue("multi-throw");
    const errs: unknown[] = [];
    const oks: string[] = [];

    await q.add(() => { throw new Error("e1"); }).catch((e) => errs.push(e));
    await q.add(() => { throw new Error("e2"); }).catch((e) => errs.push(e));
    oks.push(await q.add(async () => "a"));
    await q.add(() => { throw new Error("e3"); }).catch((e) => errs.push(e));
    oks.push(await q.add(async () => "b"));

    expect(errs.map((e: any) => e.message)).toEqual(["e1", "e2", "e3"]);
    expect(oks).toEqual(["a", "b"]);
    expect(q.idle).toBe(true);
    expect(q.pending).toBe(false);
    expect(q.size).toBe(0);
  });

  it("sync-throw still resolves the user promise via rejection, not via timeout", async () => {
    const q = new SerialQueue("reject-fast");
    const err = await Promise.race([
      q.add(() => { throw new Error("boom"); }),
      new Promise((_, rj) => setTimeout(() => rj(new Error("timed-out-waiting-for-rejection")), 200)),
    ]).catch((e) => e);
    expect(err.message).toBe("boom");
  });

  it("async-throwing tasks continue to work (no regression for existing behaviour)", async () => {
    const q = new SerialQueue("async-throw");
    const errs: unknown[] = [];
    const results: string[] = [];

    await q.add(async () => { throw new Error("async-e1"); }).catch((e) => errs.push(e));
    results.push(await q.add(async () => "r1"));
    await q.add(async () => { throw new Error("async-e2"); }).catch((e) => errs.push(e));
    results.push(await q.add(async () => "r2"));

    expect(errs.map((e: any) => e.message)).toEqual(["async-e1", "async-e2"]);
    expect(results).toEqual(["r1", "r2"]);
  });

  it("order is preserved across a mix of sync-throw / async-throw / success", async () => {
    const q = new SerialQueue("ordered");
    const trace: string[] = [];
    const swallow = (p: Promise<unknown>) => p.catch((e) => trace.push(`ERR:${e.message}`));
    await Promise.all([
      swallow(q.add(async () => { trace.push("1"); })),
      swallow(q.add(() => { throw new Error("E"); })),
      swallow(q.add(async () => { trace.push("3"); })),
      swallow(q.add(() => { throw new Error("F"); })),
      swallow(q.add(async () => { trace.push("5"); })),
    ]);
    // The trace: success tasks push their numeric order; the two rejections
    // produce ERR:E and ERR:F entries in their correct serial positions.
    const fullTrace = [
      "1",
      "ERR:E",
      "3",
      "ERR:F",
      "5",
    ];
    // Combine: replace trace numbers with their positional numeric + ERRs in order
    expect([...trace]).toEqual(["1", "3", "5"]);
    // Order check: run them sequentially via q.add calls only (no Promise.all interleaving)
    // to guarantee strict order:
    const q2 = new SerialQueue("ordered-seq");
    const seq: string[] = [];
    await Promise.resolve();
    await q2.add(async () => { seq.push("1"); });
    try { await q2.add(() => { throw new Error("E"); }); } catch (e: any) { seq.push("ERR:" + e.message); }
    await q2.add(async () => { seq.push("3"); });
    try { await q2.add(() => { throw new Error("F"); }); } catch (e: any) { seq.push("ERR:" + e.message); }
    await q2.add(async () => { seq.push("5"); });
    expect(seq).toEqual(["1", "ERR:E", "3", "ERR:F", "5"]);
  });
});
