import { describe, it, expect } from "vitest";
import { SerialQueue } from "./serial-queue.js";

describe("SerialQueue", () => {
  describe("basic execution", () => {
    it("runs tasks in FIFO order", async () => {
      const q = new SerialQueue("test");
      const order: number[] = [];

      await Promise.all([
        q.add(async () => order.push(1)),
        q.add(async () => order.push(2)),
        q.add(async () => order.push(3)),
      ]);

      expect(order).toEqual([1, 2, 3]);
    });

    it("resolves with task return value", async () => {
      const q = new SerialQueue("test");
      const result = await q.add(async () => 42);
      expect(result).toBe(42);
    });

    it("rejects when task returns rejected promise", async () => {
      const q = new SerialQueue("test");
      const err = new Error("async fail");
      await expect(q.add(async () => { throw err; })).rejects.toThrow("async fail");
    });
  });

  describe("Issue #518 — synchronous task throw", () => {
    it("does NOT deadlock when a task throws synchronously", async () => {
      const q = new SerialQueue("test");
      const err = new Error("sync fail");

      const result = q.add(() => {
        throw err;
      });

      await expect(result).rejects.toThrow("sync fail");
      expect(q.pending).toBe(false);
      expect(q.idle).toBe(true);
    });

    it("continues processing after a synchronous throw", async () => {
      const q = new SerialQueue("test");
      const order: string[] = [];

      const failing = q.add(() => {
        throw new Error("fail");
      });

      const next = q.add(async () => order.push("success"));

      await expect(failing).rejects.toThrow("fail");
      await next;

      expect(order).toEqual(["success"]);
      expect(q.idle).toBe(true);
    });

    it("propagates synchronous throw to the caller", async () => {
      const q = new SerialQueue("test");
      const err = new Error("boom");

      await expect(q.add(() => { throw err; })).rejects.toBe(err);
    });

    it("handles mixed sync-throw and async-resolve tasks", async () => {
      const q = new SerialQueue("test");

      const t1 = q.add(async () => "first");
      const t2 = q.add(() => { throw new Error("bad"); });
      const t3 = q.add(async () => "third");

      await expect(t1).resolves.toBe("first");
      await expect(t2).rejects.toThrow("bad");
      await expect(t3).resolves.toBe("third");
      expect(q.idle).toBe(true);
    });
  });

  describe("pause / start", () => {
    it("pauses execution and resumes", async () => {
      const q = new SerialQueue("test");
      const started: number[] = [];

      q.pause();
      q.add(async () => started.push(1));
      q.add(async () => started.push(2));

      expect(q.pending).toBe(false);

      q.start();
      await q.onIdle();

      expect(started).toEqual([1, 2]);
    });
  });

  describe("onIdle", () => {
    it("resolves immediately when queue is empty", async () => {
      const q = new SerialQueue("test");
      await expect(q.onIdle()).resolves.toBeUndefined();
    });

    it("resolves after all tasks complete", async () => {
      const q = new SerialQueue("test");
      const done: string[] = [];

      q.add(async () => done.push("a"));
      q.add(async () => done.push("b"));

      await q.onIdle();

      expect(done).toEqual(["a", "b"]);
    });
  });

  describe("clear", () => {
    it("rejects all pending tasks", async () => {
      const q = new SerialQueue("test");

      const p1 = q.add(async () => {});
      const p2 = q.add(async () => {});

      q.clear();

      await expect(p1).rejects.toThrow("Queue cleared");
      await expect(p2).rejects.toThrow("Queue cleared");
    });
  });

  describe("debug logger", () => {
    it("receives enqueue / dequeue / complete messages", async () => {
      const q = new SerialQueue("test");
      const msgs: string[] = [];
      q.setDebugLogger((m) => msgs.push(m));

      await q.add(async () => 1);

      expect(msgs.some((m) => m.includes("enqueued"))).toBe(true);
      expect(msgs.some((m) => m.includes("dequeued"))).toBe(true);
      expect(msgs.some((m) => m.includes("task completed"))).toBe(true);
    });
  });

  describe("size / pending / idle", () => {
    it("reports correct state transitions", async () => {
      const q = new SerialQueue("test");
      expect(q.size).toBe(0);
      expect(q.pending).toBe(false);
      expect(q.idle).toBe(true);

      const p = q.add(async () => {
        expect(q.size).toBe(0);
      });
      expect(q.pending).toBe(true);

      await p;
      expect(q.pending).toBe(false);
      expect(q.idle).toBe(true);
    });
  });
});