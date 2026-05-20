import { describe, expect, it } from "vitest";
import { SerialQueue } from "./serial-queue.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SerialQueue", () => {
  it("runs tasks with bounded concurrency", async () => {
    const queue = new SerialQueue("test", 2);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 5 }, (_, index) => queue.add(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await delay(10);
      running -= 1;
      return index;
    }));

    const results = await Promise.all(tasks);

    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(maxRunning).toBe(2);
    expect(queue.idle).toBe(true);
  });
});
