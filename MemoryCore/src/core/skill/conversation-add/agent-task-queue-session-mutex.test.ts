import { describe, expect, it } from "vitest";
import {
  LocalSkillAgentTaskQueue,
  RedisSkillAgentTaskQueue,
  type SessionTuple,
} from "./agent-task-queue.js";

const session: SessionTuple = {
  instance_id: "instance",
  space_id: "space",
  user_id: "user",
  team_id: "team",
  agent_id: "agent",
  session_id: "session",
};

describe("Skill session mutex", () => {
  it("serializes local handlers sharing one queue", async () => {
    const queue = new LocalSkillAgentTaskQueue();
    const events: string[] = [];
    const first = queue.withSessionMutex(session, { lockTtlMs: 20, waitDeadlineMs: 500 }, async () => {
      events.push("first:start");
      await sleep(30);
      events.push("first:end");
    });
    const second = queue.withSessionMutex(session, { lockTtlMs: 20, waitDeadlineMs: 500 }, async () => {
      events.push("second:start");
    });

    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("releases the local mutex when the holder throws", async () => {
    const queue = new LocalSkillAgentTaskQueue();

    await expect(queue.withSessionMutex(
      session,
      { lockTtlMs: 20, waitDeadlineMs: 500 },
      async () => { throw new Error("boom"); },
    )).rejects.toThrow("boom");

    await expect(queue.withSessionMutex(
      session,
      { lockTtlMs: 20, waitDeadlineMs: 500 },
      async () => "released",
    )).resolves.toBe("released");
  });

  it("does not serialize different sessions", async () => {
    const queue = new LocalSkillAgentTaskQueue();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = queue.withSessionMutex(session, { lockTtlMs: 20, waitDeadlineMs: 500 }, async () => {
      await firstGate;
    });
    const second = queue.withSessionMutex(
      { ...session, session_id: "other-session" },
      { lockTtlMs: 20, waitDeadlineMs: 500 },
      async () => "parallel",
    );

    await expect(second).resolves.toBe("parallel");
    releaseFirst();
    await first;
  });

  it("renews the Redis lease until the holder finishes", async () => {
    const redis = new FakeRedis();
    const firstQueue = new RedisSkillAgentTaskQueue({ client: redis as never, keyPrefix: "test" });
    const secondQueue = new RedisSkillAgentTaskQueue({ client: redis as never, keyPrefix: "test" });
    const events: string[] = [];
    const first = firstQueue.withSessionMutex(session, { lockTtlMs: 30, waitDeadlineMs: 500 }, async () => {
      events.push("first:start");
      await sleep(80);
      events.push("first:end");
    });
    await sleep(40);
    const second = secondQueue.withSessionMutex(session, { lockTtlMs: 30, waitDeadlineMs: 500 }, async () => {
      events.push("second:start");
    });

    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(redis.renewals).toBeGreaterThan(0);
  });
});

class FakeRedis {
  private readonly values = new Map<string, { value: string; expiresAt: number }>();
  renewals = 0;

  async set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null> {
    this.expire(key);
    if (args.includes("NX") && this.values.has(key)) return null;
    const px = args.indexOf("PX");
    const ttl = px >= 0 ? Number(args[px + 1]) : 0;
    this.values.set(key, { value, expiresAt: Date.now() + ttl });
    return "OK";
  }

  async eval(script: string, _numKeys: number, key: string, token: string, ttl?: number): Promise<number> {
    this.expire(key);
    const current = this.values.get(key);
    if (!current || current.value !== token) return 0;
    if (script.includes("PEXPIRE")) {
      current.expiresAt = Date.now() + Number(ttl);
      this.renewals += 1;
      return 1;
    }
    this.values.delete(key);
    return 1;
  }

  private expire(key: string): void {
    const current = this.values.get(key);
    if (current && current.expiresAt <= Date.now()) this.values.delete(key);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
