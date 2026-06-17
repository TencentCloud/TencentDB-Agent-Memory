import { describe, expect, it } from "vitest";
import { createLocalTimerTask } from "./timer-routing.js";

describe("createLocalTimerTask", () => {
  it("routes legacy L2_schedule timers to the scene extraction L2 worker", () => {
    const task = createLocalTimerTask({
      entry: { member: "session-a:L2_schedule", fireAtMs: 123 },
      defaultInstanceId: "default-inst",
      now: 456,
    });

    expect(task).toMatchObject({
      id: "L2-session-a-456",
      type: "L2",
      instanceId: "default-inst",
      sessionId: "session-a",
      priority: 0,
      createdAt: 456,
      data: {
        triggeredBy: "timer_scanner",
        timerMember: "session-a:L2_schedule",
        instanceId: "default-inst",
        targetMmdFile: undefined,
      },
    });
  });

  it("routes legacy L1_idle timers to the normal L1 worker", () => {
    const task = createLocalTimerTask({
      entry: { member: "session-a:L1_idle", fireAtMs: 123 },
      defaultInstanceId: "default-inst",
      now: 456,
    });

    expect(task.type).toBe("L1");
    expect(task.id).toBe("L1-session-a-456");
    expect(task.sessionId).toBe("session-a");
  });

  it("keeps explicit offload-l2 timers on the offload worker", () => {
    const task = createLocalTimerTask({
      entry: {
        member: "offload-l2:tenant-1:session-a:123456-topic.mmd",
        fireAtMs: 123,
      },
      defaultInstanceId: "default-inst",
      now: 456,
    });

    expect(task).toMatchObject({
      id: "offload-l2-session-a-456",
      type: "offload-l2",
      instanceId: "tenant-1",
      sessionId: "session-a",
      data: {
        timerMember: "offload-l2:tenant-1:session-a:123456-topic.mmd",
        instanceId: "tenant-1",
        targetMmdFile: "123456-topic.mmd",
      },
    });
  });
});
