import { describe, expect, it } from "vitest";
import { createKeyedMutex } from "./keyed-mutex.js";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("createKeyedMutex", () => {
  it("serializes the same key in FIFO order and releases on rejection", async () => {
    const run = createKeyedMutex();
    const log: string[] = [];
    const job = (name: string, fail = false) => run("k", async () => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
      if (fail) throw new Error(name);
      return name;
    });
    const results = await Promise.allSettled([job("a"), job("b", true), job("c")]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("does not serialize different keys", async () => {
    const run = createKeyedMutex();
    const log: string[] = [];
    await Promise.all(["x", "y"].map((k) => run(k, async () => { log.push(`${k}:start`); await tick(); log.push(`${k}:end`); })));
    expect(log.slice(0, 2).sort()).toEqual(["x:start", "y:start"]);
  });
});
