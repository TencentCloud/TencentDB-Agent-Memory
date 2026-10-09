import { describe, expect, it } from "vitest";

import { SerialQueue } from "./serial-queue.js";

describe("SerialQueue", () => {
  it("continues processing and reaches idle after a task throws synchronously", async () => {
    const queue = new SerialQueue("sync-throw");
    const executionOrder: string[] = [];

    await expect(
      queue.add(() => {
        executionOrder.push("first");
        throw new Error("sync failure");
      }),
    ).rejects.toThrow("sync failure");

    const nextTask = queue.add(async () => {
      executionOrder.push("second");
      return "completed";
    });
    const idle = queue.onIdle();

    await expect(nextTask).resolves.toBe("completed");
    await expect(idle).resolves.toBeUndefined();
    expect(executionOrder).toEqual(["first", "second"]);
    expect(queue.size).toBe(0);
    expect(queue.pending).toBe(false);
    expect(queue.idle).toBe(true);
  });
});
