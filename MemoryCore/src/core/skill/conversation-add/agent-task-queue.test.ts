import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSkillAgentTaskQueue, parseAgentTuple, serializeAgentTuple, type AgentTuple } from "./agent-task-queue.js";

const agent: AgentTuple = {
  instance_id: "instance-a", space_id: "space-a", user_id: "user-a", team_id: "team-a", agent_id: "agent-a",
};

afterEach(() => vi.useRealTimers());

describe("agent tuple isolation", () => {
  it("round-trips every isolation dimension, including the instance", () => {
    expect(parseAgentTuple(serializeAgentTuple(agent))).toEqual(agent);
    expect(serializeAgentTuple({ ...agent, instance_id: "instance-b" })).not.toBe(serializeAgentTuple(agent));
  });

  it.each(Object.keys(agent) as Array<keyof AgentTuple>)("rejects empty and delimiter-containing %s values", (field) => {
    expect(() => serializeAgentTuple({ ...agent, [field]: "" })).toThrow("non-empty string");
    expect(() => serializeAgentTuple({ ...agent, [field]: "injected|field" })).toThrow("cannot contain");
  });

  it("distinguishes legacy work from corrupt tuples so workers can purge stale entries", () => {
    expect(parseAgentTuple("space|user|team|agent")).toEqual({ instance_id: "__legacy__", space_id: "space", user_id: "user", team_id: "team", agent_id: "agent" });
    expect(parseAgentTuple("instance||user|team|agent")).toBeNull();
    expect(parseAgentTuple("too|few|fields")).toBeNull();
    expect(parseAgentTuple("instance|space|user|team|agent|extra")).toBeNull();
  });
});

describe("LocalSkillAgentTaskQueue", () => {
  it("deduplicates pending agents and preserves independent instances in FIFO order", async () => {
    const queue = new LocalSkillAgentTaskQueue();
    const other = { ...agent, instance_id: "instance-b" };
    expect(await queue.enqueueAgent(agent)).toBe(true);
    expect(await queue.enqueueAgent(agent)).toBe(false);
    expect(await queue.enqueueAgent(other)).toBe(true);
    expect(await queue.dequeueAgent(0)).toEqual(agent);
    expect(await queue.enqueueAgent(agent)).toBe(false);
    expect(await queue.dequeueAgent(0)).toEqual(other);
    expect(await queue.dequeueAgent(0)).toBeNull();
    await queue.removeAgent(agent);
    expect(await queue.enqueueAgent(agent)).toBe(true);
  });

  it("retains peeked work for crash recovery and rotates fairly between agents", async () => {
    const queue = new LocalSkillAgentTaskQueue();
    const other = { ...agent, agent_id: "agent-b" };
    await queue.enqueueAgent(agent);
    await queue.enqueueAgent(other);
    expect(await queue.peekAgent(0)).toEqual(agent);
    expect(await queue.peekAgent(0)).toEqual(other);
    expect(await queue.peekAgent(0)).toEqual(agent);
    await queue.removeAgent(agent);
    expect(await queue.peekAgent(0)).toEqual(other);
    expect(await queue.scanAgentSet()).toEqual([serializeAgentTuple(other)]);
  });

  it("removes every duplicate list entry when completed work is removed", async () => {
    const queue = new LocalSkillAgentTaskQueue();
    await queue.enqueueAgent(agent);
    await queue.requeueAgent(agent);
    await queue.requeueAgent(agent);
    await queue.removeAgent(agent);
    expect(await queue.dequeueAgent(0)).toBeNull();
    expect(await queue.scanAgentSet()).toEqual([]);
  });

  it("wakes a blocked consumer and removes timed-out consumers", async () => {
    vi.useFakeTimers();
    const queue = new LocalSkillAgentTaskQueue();
    const waiting = queue.dequeueAgent(100);
    await queue.enqueueAgent(agent);
    await expect(waiting).resolves.toEqual(agent);
    const timeout = queue.dequeueAgent(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(timeout).resolves.toBeNull();
    await queue.requeueAgent(agent);
    expect(await queue.dequeueAgent(0)).toEqual(agent);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes a same-agent critical section but permits another instance to proceed", async () => {
    vi.useFakeTimers();
    const queue = new LocalSkillAgentTaskQueue();
    const opts = { lockTtlMs: 1000, waitDeadlineMs: 500 };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.withTasksMutex(agent, opts, () => held);
    const secondAction = vi.fn().mockResolvedValue("second");
    const second = queue.withTasksMutex(agent, opts, secondAction);
    expect(secondAction).not.toHaveBeenCalled();
    await expect(queue.withTasksMutex({ ...agent, instance_id: "instance-b" }, opts, async () => "independent")).resolves.toBe("independent");
    release();
    await first;
    await vi.advanceTimersByTimeAsync(10);
    await expect(second).resolves.toBe("second");
    expect(secondAction).toHaveBeenCalledOnce();
  });

  it("releases the tasks mutex after a rejected action", async () => {
    const queue = new LocalSkillAgentTaskQueue();
    const opts = { lockTtlMs: 1000, waitDeadlineMs: 100 };
    await expect(queue.withTasksMutex(agent, opts, async () => { throw new Error("write failed"); })).rejects.toThrow("write failed");
    await expect(queue.withTasksMutex(agent, opts, async () => "retry")).resolves.toBe("retry");
  });

  it("prevents stale lock holders from releasing or renewing a replacement lease", async () => {
    vi.useFakeTimers();
    const queue = new LocalSkillAgentTaskQueue();
    const first = (await queue.acquireExtractLock(agent, 100))!;
    expect(await queue.acquireExtractLock(agent, 100)).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    const replacement = (await queue.acquireExtractLock(agent, 100))!;
    expect(replacement.token).not.toBe(first.token);
    await queue.releaseExtractLock(first);
    expect(await queue.renewExtractLock(first, 100)).toBe(false);
    expect(await queue.acquireExtractLock(agent, 100)).toBeNull();
    await queue.releaseExtractLock(replacement);
    expect(await queue.acquireExtractLock(agent, 100)).not.toBeNull();
  });

  it("does not resurrect a lease at its exact expiry boundary", async () => {
    vi.useFakeTimers();
    const queue = new LocalSkillAgentTaskQueue();
    const handle = (await queue.acquireExtractLock(agent, 100))!;
    await vi.advanceTimersByTimeAsync(100);
    expect(await queue.renewExtractLock(handle, 100)).toBe(false);
    expect(await queue.acquireExtractLock(agent, 100)).not.toBeNull();
  });

  it("extends a live lease until the renewed deadline", async () => {
    vi.useFakeTimers();
    const queue = new LocalSkillAgentTaskQueue();
    const handle = (await queue.acquireExtractLock(agent, 100))!;
    await vi.advanceTimersByTimeAsync(80);
    expect(await queue.renewExtractLock(handle, 100)).toBe(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(await queue.acquireExtractLock(agent, 100)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await queue.acquireExtractLock(agent, 100)).not.toBeNull();
  });
});
