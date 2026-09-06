import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdapterConfig } from "../src/config.js";
import { TurnCoordinator } from "../src/coordinator.js";
import { DeliveryStore } from "../src/state.js";
import type { OpenCodeMessage } from "../src/types.js";

const config: AdapterConfig = {
  endpoint: "http://127.0.0.1:8420", apiKey: "key", serviceId: "space", teamId: "team",
  agentId: "opencode", userId: "user", stateDir: "unused", timeoutMs: 1000, recallLimit: 5,
  maxContextChars: 8000, maxMessageChars: 8192, maxSkillBytes: 480000,
  recallEnabled: true, captureEnabled: true, skillEnabled: true, allowInsecureHttp: false,
};

const messages: OpenCodeMessage[] = [
  { info: { id: "u", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "q" }] },
  { info: { id: "a", parentID: "u", role: "assistant", time: { completed: 2 } }, parts: [{ type: "text", text: "a" }] },
];

describe("turn delivery coordinator", () => {
  it("serializes concurrent idle events and delivers once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-opencode-coordinator-"));
    const gateway = { captureL0: vi.fn().mockResolvedValue(undefined), captureSkill: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new TurnCoordinator(config, gateway as never, new DeliveryStore(dir), vi.fn());
    await Promise.all([coordinator.capture("s", messages), coordinator.capture("s", messages)]);
    expect(gateway.captureL0).toHaveBeenCalledTimes(1);
    expect(gateway.captureSkill).toHaveBeenCalledTimes(1);
    expect((coordinator as unknown as { sessionChains: Map<string, Promise<void>> }).sessionChains.size).toBe(0);
  });

  it("recovers only the failed pipeline after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-opencode-coordinator-"));
    const firstGateway = {
      captureL0: vi.fn().mockResolvedValue(undefined),
      captureSkill: vi.fn().mockRejectedValue(new Error("offline")),
    };
    await new TurnCoordinator(config, firstGateway as never, new DeliveryStore(dir), vi.fn()).capture("s", messages);
    const recoveredGateway = { captureL0: vi.fn(), captureSkill: vi.fn().mockResolvedValue(undefined) };
    await new TurnCoordinator(config, recoveredGateway as never, new DeliveryStore(dir), vi.fn()).recover();
    expect(recoveredGateway.captureL0).not.toHaveBeenCalled();
    expect(recoveredGateway.captureSkill).toHaveBeenCalledTimes(1);
  });

  it("replays an acknowledged L0 write with the same key after an ack crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-opencode-coordinator-"));
    const firstStore = new DeliveryStore(dir);
    const originalMark = firstStore.mark.bind(firstStore);
    let interruptAck = true;
    firstStore.mark = async (key, pipeline) => {
      if (pipeline === "l0" && interruptAck) {
        interruptAck = false;
        throw new Error("simulated process termination before local ack");
      }
      return originalMark(key, pipeline);
    };

    const requests: string[] = [];
    const accepted = new Set<string>();
    const notifications: string[] = [];
    const gateway = {
      captureL0: vi.fn(async (turn: { key: string }) => {
        requests.push(turn.key);
        accepted.add(turn.key);
      }),
      captureSkill: vi.fn(async (turn: { key: string }) => {
        notifications.push(turn.key);
      }),
    };
    await new TurnCoordinator(config, gateway as never, firstStore, vi.fn()).capture("s", messages);

    const recoveredGateway = {
      captureL0: vi.fn(async (turn: { key: string }) => {
        requests.push(turn.key);
        accepted.add(turn.key);
      }),
      captureSkill: vi.fn(),
    };
    await new TurnCoordinator(config, recoveredGateway as never, new DeliveryStore(dir), vi.fn()).recover();

    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(accepted.size).toBe(1);
    expect(notifications).toEqual([requests[0]]);
    expect(recoveredGateway.captureL0).toHaveBeenCalledTimes(1);
  });

  it("retires legacy Skill-pending records when Skill is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-opencode-coordinator-"));
    const store = new DeliveryStore(dir);
    const pending = await store.begin({
      key: "a".repeat(64), sessionId: "s", sourceId: "a", user: "q", assistant: "a",
      capturedAtMs: 1, skillMessages: [],
    }, true);
    await store.mark(pending.key, "l0");
    const gateway = { captureL0: vi.fn(), captureSkill: vi.fn() };
    const coordinator = new TurnCoordinator(
      { ...config, skillEnabled: false },
      gateway as never,
      store,
      vi.fn(),
    );

    await coordinator.recover();

    expect(gateway.captureL0).not.toHaveBeenCalled();
    expect(gateway.captureSkill).not.toHaveBeenCalled();
    expect(await store.pending()).toEqual([]);
  });

  it("refreshes stale recovery records before sending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-opencode-coordinator-"));
    const store = new DeliveryStore(dir);
    const turn = completedMessages("s", "u", "a");
    const coordinatorGateway = { captureL0: vi.fn().mockResolvedValue(undefined), captureSkill: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new TurnCoordinator(config, coordinatorGateway as never, store, vi.fn());
    await Promise.all([coordinator.capture("s", turn), coordinator.recover(), coordinator.recover()]);
    expect(coordinatorGateway.captureL0).toHaveBeenCalledTimes(1);
    expect(coordinatorGateway.captureSkill).toHaveBeenCalledTimes(1);
  });

  it("uses a filesystem claim to prevent duplicate recovery across plugin processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-opencode-coordinator-"));
    const store = new DeliveryStore(dir);
    const pending = await store.begin({
      key: "b".repeat(64), sessionId: "s", sourceId: "b", user: "q", assistant: "a",
      capturedAtMs: 1, skillMessages: [],
    }, false);
    expect(pending.l0).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gateway = { captureL0: vi.fn().mockImplementation(() => gate), captureSkill: vi.fn() };
    const first = new TurnCoordinator({ ...config, skillEnabled: false }, gateway as never, new DeliveryStore(dir), vi.fn());
    const second = new TurnCoordinator({ ...config, skillEnabled: false }, gateway as never, new DeliveryStore(dir), vi.fn());

    const recoveries = Promise.all([first.recover(), second.recover()]);
    await vi.waitFor(() => expect(gateway.captureL0).toHaveBeenCalledTimes(1));
    release();
    await recoveries;
    expect(gateway.captureL0).toHaveBeenCalledTimes(1);
  });

  it("retries a pending record after another process releases its claim", async () => {
    vi.useFakeTimers();
    try {
      const dir = await mkdtemp(join(tmpdir(), "tdai-opencode-coordinator-"));
      const firstStore = new DeliveryStore(dir);
      await firstStore.begin({
        key: "c".repeat(64), sessionId: "s", sourceId: "c", user: "q", assistant: "a",
        capturedAtMs: 1, skillMessages: [],
      }, false);
      let release!: () => void;
      const holder = firstStore.claim("c".repeat(64), () => new Promise<void>((resolve) => { release = resolve; }));
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const gateway = { captureL0: vi.fn().mockResolvedValue(undefined), captureSkill: vi.fn() };
      const second = new TurnCoordinator(
        { ...config, skillEnabled: false },
        gateway as never,
        new DeliveryStore(dir),
        vi.fn(),
      );
      await second.recover();
      expect(gateway.captureL0).not.toHaveBeenCalled();
      release();
      await holder;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(gateway.captureL0).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it("catches up every unrecorded completed turn in transcript order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-opencode-coordinator-"));
    const gateway = { captureL0: vi.fn().mockResolvedValue(undefined), captureSkill: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new TurnCoordinator(config, gateway as never, new DeliveryStore(dir), vi.fn());
    await coordinator.capture("s", [
      ...completedMessages("s", "u1", "a1", "q1", "r1"),
      ...completedMessages("s", "u2", "a2", "q2", "r2"),
    ]);
    expect(gateway.captureL0.mock.calls.map(([turn]) => turn.user)).toEqual(["q1", "q2"]);
    expect(gateway.captureSkill).toHaveBeenCalledTimes(2);
  });
});

function completedMessages(
  _sessionId: string,
  userId: string,
  assistantId: string,
  question = "q",
  answer = "a",
): OpenCodeMessage[] {
  return [
    { info: { id: userId, role: "user", time: { created: 1 } }, parts: [{ type: "text", text: question }] },
    { info: { id: assistantId, parentID: userId, role: "assistant", time: { completed: 2 } }, parts: [{ type: "text", text: answer }] },
  ];
}
