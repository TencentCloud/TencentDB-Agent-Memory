import { TDAMError } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { access, mkdtemp, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CursorConfig } from "../src/config.js";
import { appendPendingEvent } from "../src/pending.js";
import { runWorker, type ConversationClient, type WorkerOptions } from "../src/worker.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfig(): Promise<CursorConfig> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "cursor-worker-v3-"));
  tempDirs.push(rootDir);
  return {
    rootDir,
    gatewayUrl: "https://memory.example.com",
    gatewayApiKey: "secret",
    serviceId: "service-1",
    teamId: "team-1",
    agentId: "agent-1",
    userId: "user-1",
    taskId: "task-1",
    captureTimeoutMs: 60_000,
    recallTimeoutMs: 2_000,
    executablePath: "/bin/memory-tencentdb-cursor",
    transcriptsRoot: path.join(rootDir, ".cursor", "projects"),
  };
}

async function completePending(
  config: CursorConfig,
  conversationId = "c1",
  generationId = "g1",
): Promise<string> {
  await appendPendingEvent(config.rootDir, {
    v: 1,
    event: "user",
    conversation_id: conversationId,
    generation_id: generationId,
    text: `问题-${conversationId}`,
    at_ms: 1,
  });
  await appendPendingEvent(config.rootDir, {
    v: 1,
    event: "assistant",
    conversation_id: conversationId,
    generation_id: generationId,
    text: `回答-${conversationId}`,
    at_ms: 2,
  });
  return appendPendingEvent(config.rootDir, {
    v: 1,
    event: "stop",
    conversation_id: conversationId,
    generation_id: generationId,
    status: "completed",
    at_ms: 3,
  });
}

function harness(config: CursorConfig, client: ConversationClient): WorkerOptions {
  return {
    config,
    client,
    acquireLock: vi.fn().mockResolvedValue(vi.fn()),
    log: vi.fn(),
    now: Date.now,
  };
}

describe("Cursor v3 worker", () => {
  // SDK resolve 才是业务 ACK, 请求必须包含严格 session 和本轮两条消息.
  it("SDK resolve 后删除 pending", async () => {
    const config = await makeConfig();
    const file = await completePending(config);
    const client: ConversationClient = {
      addConversation: vi.fn().mockResolvedValue({ accepted_ids: ["1", "2"], total_count: 2 }),
    };

    await runWorker(harness(config, client));

    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.addConversation).toHaveBeenCalledWith({
      session_id: "cursor:c1",
      messages: [
        { role: "user", content: "问题-c1" },
        { role: "assistant", content: "回答-c1" },
      ],
    });
  });

  // 只有明确的 400/413 SDK 错误允许丢弃不可投递记录.
  it.each([400, 413])("TDAMError %s 删除 pending", async (code) => {
    const config = await makeConfig();
    const file = await completePending(config);
    const client: ConversationClient = {
      addConversation: vi.fn().mockRejectedValue(new TDAMError(code, "invalid")),
    };

    await runWorker(harness(config, client));

    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // 422、业务限流、参数、网络和未知错误均保留 pending 并停止本轮 drain.
  it.each([
    new TDAMError(422, "invalid isolation"),
    new TDAMError(4291, "quota"),
    new TypeError("session missing"),
    new TypeError("fetch failed"),
    new Error("unknown"),
  ])("%s 保留 pending", async (error) => {
    const config = await makeConfig();
    const first = await completePending(config, "c1", "g1");
    const second = await completePending(config, "c2", "g2");
    const client: ConversationClient = {
      addConversation: vi.fn().mockRejectedValue(error),
    };

    await runWorker(harness(config, client));

    await expect(access(first)).resolves.toBeUndefined();
    await expect(access(second)).resolves.toBeUndefined();
    expect(client.addConversation).toHaveBeenCalledOnce();
  });

  // 配置校验失败不得删除 pending, 也不得记录隔离值或服务端消息.
  it("client 创建失败时保留 pending 并记录有限字段", async () => {
    const config = await makeConfig();
    config.gatewayApiKey = undefined;
    const file = await completePending(config);
    const log = vi.fn();

    await runWorker({
      config,
      createClient: vi.fn(() => { throw new Error("gatewayApiKey is required: secret-value"); }),
      acquireLock: vi.fn().mockResolvedValue(vi.fn()),
      log,
    });

    await expect(access(file)).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-value");
    expect(log).toHaveBeenCalledWith("capture_retained", { error_name: "Error" });
  });

  // 不完整 pending 仅按文件 mtime 在 24 小时后过期, 完整记录不按 TTL 删除.
  it("只清理过期的不完整 pending", async () => {
    const config = await makeConfig();
    const incomplete = await appendPendingEvent(config.rootDir, {
      v: 1,
      event: "user",
      conversation_id: "old",
      generation_id: "g1",
      text: "问题",
      at_ms: 1,
    });
    const complete = await completePending(config);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await utimes(incomplete, old, old);
    await utimes(complete, old, old);
    const client: ConversationClient = {
      addConversation: vi.fn().mockRejectedValue(new Error("offline")),
    };

    await runWorker(harness(config, client));

    await expect(access(incomplete)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(complete)).resolves.toBeUndefined();
  });

  // 空扫描不应构造 SDK client 或访问网络.
  it("没有完整 pending 时不创建 client", async () => {
    const config = await makeConfig();
    const createClient = vi.fn<() => ConversationClient>();

    await runWorker({
      config,
      createClient,
      acquireLock: vi.fn().mockResolvedValue(vi.fn()),
      log: vi.fn(),
    });

    expect(createClient).not.toHaveBeenCalled();
  });

  // ACK 后本地删除失败时必须停止, 避免同一 owner 立即重发.
  it("删除失败时保留并停止", async () => {
    const config = await makeConfig();
    const file = await completePending(config);
    const remove = vi.fn().mockRejectedValue(new Error("permission denied"));
    const client: ConversationClient = {
      addConversation: vi.fn().mockResolvedValue({}),
    };
    const options = { ...harness(config, client), remove };

    await runWorker(options);

    await expect(access(file)).resolves.toBeUndefined();
    expect(options.log).toHaveBeenCalledWith(
      "pending_delete_failed",
      expect.objectContaining({ error: "permission denied" }),
    );
    expect(options.log).not.toHaveBeenCalledWith("capture_acked", expect.anything());
  });

  // owner 工作期间新增的完整 pending 必须在同一锁内继续投递.
  it("成功后重扫新增 pending", async () => {
    const config = await makeConfig();
    await completePending(config, "c1", "g1");
    let created = false;
    const client: ConversationClient = {
      addConversation: vi.fn(async () => {
        if (!created) {
          created = true;
          await completePending(config, "c2", "g2");
        }
        return {};
      }),
    };

    await runWorker(harness(config, client));

    expect(client.addConversation).toHaveBeenCalledTimes(2);
  });
});
