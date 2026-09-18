import { expect, it } from "vitest";
import type { Redis } from "ioredis";
import { RedisBindingRepo } from "../binding-repo.js";

it("replacing a binding without a task removes a previously stored Redis task", async () => {
  const fields: Record<string, string> = {};
  const redis = {
    hgetall: async () => ({ ...fields }),
    multi() {
      const operations: Array<() => void> = [];
      const tx = {
        hset(_key: string, values: Record<string, string>) { operations.push(() => Object.assign(fields, values)); return tx; },
        hdel(_key: string, name: string) { operations.push(() => { delete fields[name]; }); return tx; },
        expire() { return tx; },
        async exec() { operations.forEach((op) => op()); return []; },
      };
      return tx;
    },
  };
  const repo = new RedisBindingRepo(redis as unknown as Redis);
  const base = { outcome: "initialized" as const, userId: "user", teamId: "team", agentId: "agent" };
  await repo.putBinding("space", "session", { ...base, taskId: "default" });
  expect((await repo.getBinding("space", "session"))?.taskId).toBe("default");
  await repo.putBinding("space", "session", base);
  expect((await repo.getBinding("space", "session"))?.taskId).toBeUndefined();
  expect((await repo.getBinding("space", "session"))?.agentId).toBe("agent");
  await repo.putBinding("space", "session", { ...base, taskId: "real" });
  expect((await repo.getBinding("space", "session"))?.taskId).toBe("real");
});
