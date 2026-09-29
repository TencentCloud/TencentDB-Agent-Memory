import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalStateBackend } from "../core/state/local-backend.js";
import type { TaskPayload } from "../core/state/types.js";

/**
 * Drive the window deterministically instead of depending on the wall clock.
 * `deferredTimerType` stays real — it is pure.
 */
const windowState = vi.hoisted(() => ({ open: true, nextOpenMs: 0 }));

vi.mock("../utils/llm-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/llm-window.js")>();
  return {
    ...actual,
    isLlmWindowOpen: () => windowState.open,
    nextLlmWindowOpenMs: () => windowState.nextOpenMs,
  };
});

import { PipelineWorker, type TaskExecutor } from "./pipeline-worker.js";

const NEXT_OPEN_MS = 1_700_000_000_000;
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeTask(over: Partial<TaskPayload> = {}): TaskPayload {
  return {
    id: "task-1",
    type: "L1",
    instanceId: "inst-1",
    sessionId: "sess-1",
    priority: 0,
    createdAt: Date.now(),
    ...over,
  };
}

async function buildWorker(task: TaskPayload) {
  const backend = new LocalStateBackend();
  const executor: TaskExecutor = {
    executeL1: vi.fn(async () => {}),
    executeL2: vi.fn(async () => {}),
    executeL3: vi.fn(async () => {}),
  };
  const worker = new PipelineWorker(backend, executor, { workerId: "w-test" }, quietLogger);

  await backend.enqueueTask(task);
  const claimed = await backend.consumeTask("w-test", 0);
  return { backend, executor, worker, claimed: claimed as TaskPayload };
}

/** processTask is private; the gate is what we are pinning down here. */
function run(worker: PipelineWorker, task: TaskPayload): Promise<void> {
  return (worker as unknown as { processTask(t: TaskPayload): Promise<void> }).processTask(task);
}

afterEach(() => {
  windowState.open = true;
  windowState.nextOpenMs = 0;
});

describe("processTask LLM window gate", () => {
  describe("while the window is closed", () => {
    it("defers an L1 task, re-arms its timer and never executes it", async () => {
      windowState.open = false;
      windowState.nextOpenMs = NEXT_OPEN_MS;
      const { backend, executor, worker, claimed } = await buildWorker(makeTask());
      const setTimer = vi.spyOn(backend, "setTimer");

      await run(worker, claimed);

      expect(executor.executeL1).not.toHaveBeenCalled();
      expect(setTimer).toHaveBeenCalledTimes(1);
      expect(setTimer.mock.calls[0]![0]).toBe("inst-1");
      expect(setTimer.mock.calls[0]![1]).toBe("sess-1:L1_idle");
      expect(setTimer.mock.calls[0]![2]).toBe(NEXT_OPEN_MS);
    });

    it("acks the deferred task so it is not redelivered", async () => {
      windowState.open = false;
      const { backend, worker, claimed } = await buildWorker(makeTask());
      // consumeTask only ever returns *pending* tasks, so it cannot tell an
      // acked task from one left in flight — watch the ack itself instead.
      const ackIfOwned = vi.spyOn(backend, "ackTaskIfOwned");

      await run(worker, claimed);

      expect(ackIfOwned).toHaveBeenCalledTimes(1);
      expect(ackIfOwned).toHaveResolvedWith(true);
    });

    it("routes flush to the L1 timer and L3 to the L3 timer", async () => {
      for (const [type, member] of [
        ["flush", "sess-1:L1_idle"],
        ["L3", "sess-1:L3_deferred"],
      ] as const) {
        windowState.open = false;
        const { backend, worker, claimed } = await buildWorker(makeTask({ type }));
        const setTimer = vi.spyOn(backend, "setTimer");

        await run(worker, claimed);

        expect(setTimer.mock.calls[0]![1]).toBe(member);
      }
    });

    it("carries team/agent scope into the timer member", async () => {
      windowState.open = false;
      const { backend, worker, claimed } = await buildWorker(
        makeTask({ teamId: "team-a", agentId: "agent-b" }),
      );
      const setTimer = vi.spyOn(backend, "setTimer");

      await run(worker, claimed);

      expect(setTimer.mock.calls[0]![1]).toContain("team-a");
      expect(setTimer.mock.calls[0]![1]).toContain("agent-b");
    });

    it("does not defer non-LLM tasks such as offload-l1", async () => {
      const { backend, worker, claimed } = await buildWorker(makeTask({ type: "offload-l1" }));
      const setTimer = vi.spyOn(backend, "setTimer");

      await run(worker, claimed);

      expect(setTimer).not.toHaveBeenCalled();
    });

    it("leaves the task unacked when re-arming the timer fails", async () => {
      windowState.open = false;
      const { backend, worker, claimed } = await buildWorker(makeTask());
      vi.spyOn(backend, "setTimer").mockRejectedValueOnce(new Error("backend down"));
      const ackIfOwned = vi.spyOn(backend, "ackTaskIfOwned");

      await run(worker, claimed);

      // Unacked on purpose: the task stays in flight so stale recovery can
      // redeliver it once the backend is healthy again.
      expect(ackIfOwned).not.toHaveBeenCalled();
    });
  });

  describe("while the window is open", () => {
    it("does not defer anything", async () => {
      const { backend, worker, claimed } = await buildWorker(makeTask());
      const setTimer = vi.spyOn(backend, "setTimer");

      await run(worker, claimed);

      expect(setTimer).not.toHaveBeenCalled();
    });

    it("runs the task instead of deferring it", async () => {
      const { executor, worker, claimed } = await buildWorker(makeTask());

      await run(worker, claimed);

      expect(executor.executeL1).toHaveBeenCalledTimes(1);
    });
  });
});
