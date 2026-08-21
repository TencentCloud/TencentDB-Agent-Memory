import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createL1Runner } from "./pipeline-factory.js";
import { parseConfig } from "../config.js";
import type { Logger } from "pino";
import type { IMemoryStore, L0SessionGroup } from "../core/store/types.js";
import type { LLMRunner } from "../core/types.js";

const noopLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
} as unknown as Logger;

interface FakeMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  recordedAtMs: number;
}

function makeVectorStore(groups: L0SessionGroup[]): IMemoryStore {
  return {
    isDegraded: () => false,
    queryL0GroupedBySessionId: async () => groups,
  } as unknown as IMemoryStore;
}

function makeLLMRunner(captured: string[]): LLMRunner {
  return {
    run: async (params) => {
      captured.push(params.systemPrompt);
      // 空 memories → 不触发落库（本测试只关心 prompt/resolver 链路）
      return JSON.stringify([{ scene_name: "测试场景", message_ids: [], memories: [] }]);
    },
  } as unknown as LLMRunner;
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "l1-runner-test-"));
}

function makeMessages(userId: string): L0SessionGroup {
  return {
    sessionId: "s1",
    teamId: "t1",
    taskId: "task1",
    userId,
    agentId: "a1",
    messages: [
      { id: `m-${userId}-1`, role: "user", content: `hello from ${userId}`, timestamp: 1_000, recordedAtMs: 1_000 },
    ] as unknown as L0SessionGroup["messages"],
  };
}

describe("createL1Runner resolveUserDisplayName", () => {
  it("按 group.userId 调用 resolver，并透传本次 runner 的 instanceId", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const captured: string[] = [];
    const dir = makeTmpDir();
    try {
      const run = createL1Runner({
        pluginDataDir: dir,
        cfg: parseConfig({}),
        openclawConfig: undefined,
        vectorStore: makeVectorStore([makeMessages("u1")]),
        embeddingService: undefined,
        logger: noopLogger,
        getInstanceId: () => "inst-a",
        llmRunner: makeLLMRunner(captured),
        resolveUserDisplayName: async (userId, instanceId) => {
          calls.push([userId, instanceId]);
          return "Alice";
        },
      });
      const result = await run({ sessionKey: "s1" });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["u1", "inst-a"]);
      // 显示名注入 extraction system prompt
      expect(captured[0]).toContain("用户（Alice）");
      expect(captured[0]).not.toContain("[姓名]");
      expect(result.processedCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("两个 service instance 并发跑 L1：各自查到正确实例、不串名", async () => {
    const capturedA: string[] = [];
    const capturedB: string[] = [];
    const dirA = makeTmpDir();
    const dirB = makeTmpDir();
    try {
      const makeRunner = (dir: string, instanceId: string, captured: string[]) =>
        createL1Runner({
          pluginDataDir: dir,
          cfg: parseConfig({}),
          openclawConfig: undefined,
          vectorStore: makeVectorStore([makeMessages("u1")]),
          embeddingService: undefined,
          logger: noopLogger,
          getInstanceId: () => instanceId,
          llmRunner: makeLLMRunner(captured),
          // 同一 user_id，不同实例 → 不同显示名
          resolveUserDisplayName: async (_userId, gotInstanceId) =>
            gotInstanceId === "inst-a" ? "Alice" : "Bob",
        });

      const runA = makeRunner(dirA, "inst-a", capturedA);
      const runB = makeRunner(dirB, "inst-b", capturedB);

      // 并发执行两个实例的 L1
      const [resA, resB] = await Promise.all([
        runA({ sessionKey: "s1" }),
        runB({ sessionKey: "s1" }),
      ]);

      expect(capturedA[0]).toContain("用户（Alice）");
      expect(capturedB[0]).toContain("用户（Bob）");
      expect(capturedA[0]).not.toContain("用户（Bob）");
      expect(capturedB[0]).not.toContain("用户（Alice）");
      expect(resA.processedCount).toBe(1);
      expect(resB.processedCount).toBe(1);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("resolver 抛错不中断提取（失败安全），prompt 走无名字兜底", async () => {
    const captured: string[] = [];
    const dir = makeTmpDir();
    try {
      const run = createL1Runner({
        pluginDataDir: dir,
        cfg: parseConfig({}),
        openclawConfig: undefined,
        vectorStore: makeVectorStore([makeMessages("u1")]),
        embeddingService: undefined,
        logger: noopLogger,
        getInstanceId: () => "inst-a",
        llmRunner: makeLLMRunner(captured),
        resolveUserDisplayName: async () => {
          throw new Error("metadata unavailable");
        },
      });
      const result = await run({ sessionKey: "s1" });

      expect(result.processedCount).toBe(1);
      expect(captured[0]).toContain("通用用户称呼");
      expect(captured[0]).not.toContain("[姓名]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
