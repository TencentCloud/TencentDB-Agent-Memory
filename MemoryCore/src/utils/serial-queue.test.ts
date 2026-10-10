import { describe, expect, it } from "vitest";

import { SerialQueue } from "./serial-queue.js";

describe("SerialQueue", () => {
  it("resolves existing idle waiters when a paused queue is cleared", async () => {
    const queue = new SerialQueue("test");
    queue.pause();

    const task = queue.add(async () => "never runs");
    const rejection = expect(task).rejects.toThrow("Queue cleared");
    let idle = false;
    void queue.onIdle().then(() => {
      idle = true;
    });

    queue.clear();
    await rejection;
    await Promise.resolve();

    expect(queue.idle).toBe(true);
    expect(idle).toBe(true);
  });
});
