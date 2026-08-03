import { describe, expect, it, vi } from "vitest";

import { BuildQueue } from "./build-queue.js";

function activeQueueCount(queue: BuildQueue): number {
  return (
    queue as unknown as {
      queues: Map<string, unknown>;
    }
  ).queues.size;
}

async function expectQueuesReleased(queue: BuildQueue): Promise<void> {
  await vi.waitFor(() => {
    expect(activeQueueCount(queue)).toBe(0);
  });
}

describe("BuildQueue", () => {
  it("releases queues after many distinct asset jobs become idle", async () => {
    const queue = new BuildQueue();

    for (let i = 0; i < 100; i++) {
      queue.enqueue(`asset-${i}`, async () => {});
    }

    await queue.onIdle();
    await expectQueuesReleased(queue);
  });

  it("releases a queue after a rejected job", async () => {
    const queue = new BuildQueue();

    queue.enqueue("failed-asset", async () => {
      throw new Error("build failed");
    });

    await queue.onIdle("failed-asset");
    await expectQueuesReleased(queue);
  });

  it("keeps a reused queue until every job for the key finishes", async () => {
    const queue = new BuildQueue();
    const events: string[] = [];
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    queue.enqueue("shared-asset", async () => {
      events.push("first");
    });
    queue.enqueue("shared-asset", async () => {
      events.push("second-start");
      await secondGate;
      events.push("second-end");
    });

    await vi.waitFor(() => {
      expect(events).toEqual(["first", "second-start"]);
    });
    expect(activeQueueCount(queue)).toBe(1);

    releaseSecond();
    await queue.onIdle("shared-asset");
    await expectQueuesReleased(queue);
    expect(events).toEqual(["first", "second-start", "second-end"]);
  });
});
