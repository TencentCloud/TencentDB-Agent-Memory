import { describe, expect, it } from "vitest";

import { SerialQueue } from "./serial-queue.js";

describe("SerialQueue", () => {
  it("continues processing and reaches idle after a task throws synchronously", async () => {
    const queue = new SerialQueue("sync-throw");
    const executionOrder: string[] = [];

    const failedTask = queue.add(() => {
      executionOrder.push("first");
      throw new Error("sync failure");
    });
    const nextTask = queue.add(async () => {
      executionOrder.push("second");
      return "completed";
    });

    await expect(failedTask).rejects.toThrow("sync failure");
    await expect(
      Promise.race([
        nextTask,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("next task timed out")), 100);
        }),
      ]),
    ).resolves.toBe("completed");
    await expect(queue.onIdle()).resolves.toBeUndefined();

    expect(executionOrder).toEqual(["first", "second"]);
    expect(queue.size).toBe(0);
    expect(queue.pending).toBe(false);
    expect(queue.idle).toBe(true);
  });
});
