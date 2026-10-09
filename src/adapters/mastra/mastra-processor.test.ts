import { MessageList } from "@mastra/core/agent";
import type {
  ProcessInputArgs,
  ProcessOutputResultArgs,
  Processor,
} from "@mastra/core/processors";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";
import type { GatewayMemoryClient } from "../gateway-client/index.js";
import {
  createMastraMemoryProcessor,
  flushMastraSession,
} from "./index.js";

function createClient() {
  return {
    recall: vi.fn().mockResolvedValue({ context: "prefers concise answers" }),
    capture: vi.fn().mockResolvedValue({ l0_recorded: 1, scheduler_notified: true }),
    endSession: vi.fn().mockResolvedValue({ flushed: true }),
  } as unknown as GatewayMemoryClient;
}

function createMessageList(threadId = "thread-1", resourceId = "user-1") {
  const messageList = new MessageList({ threadId, resourceId });
  messageList.add({ role: "user", content: "How should I format this answer?" }, "input");
  return messageList;
}

function createInputArgs(
  messageList: MessageList,
  requestContext?: RequestContext,
): ProcessInputArgs {
  return {
    messages: messageList.get.all.db(),
    messageList,
    systemMessages: [],
    state: {},
    requestContext,
    retryCount: 0,
    abort: (reason?: string) => {
      throw new Error(reason ?? "aborted");
    },
  } as ProcessInputArgs;
}

function createOutputArgs(
  messageList: MessageList,
  requestContext?: RequestContext,
  finishReason = "stop",
): ProcessOutputResultArgs {
  return {
    // Mastra's real ProcessorRunner passes only the response lane here.
    messages: messageList.get.response.db(),
    messageList,
    state: {},
    requestContext,
    retryCount: 0,
    abort: (reason?: string) => {
      throw new Error(reason ?? "aborted");
    },
    result: {
      text: "Use a short Markdown list.",
      finishReason,
      steps: [],
      usage: {
        inputTokens: 10,
        outputTokens: 6,
        totalTokens: 16,
      },
    },
  } as ProcessOutputResultArgs;
}

describe("Mastra memory processor", () => {
  it("is exported from the package entrypoint", async () => {
    const packageEntry = await import("../../../index.js");

    expect(
      (packageEntry as Record<string, unknown>).createMastraMemoryProcessor,
    ).toBe(createMastraMemoryProcessor);
    expect((packageEntry as Record<string, unknown>).flushMastraSession).toBe(
      flushMastraSession,
    );
  });

  it("recalls before generation and injects a tagged system message", async () => {
    const client = createClient();
    const processor = createMastraMemoryProcessor({ client });
    const messageList = createMessageList();

    const result = await processor.processInput?.(createInputArgs(messageList));

    expect(client.recall).toHaveBeenCalledWith({
      query: "How should I format this answer?",
      session_key: "mastra:thread-1",
      user_id: "user-1",
    });
    expect(result).toBe(messageList);
    expect(messageList.getSystemMessages("tencentdb-agent-memory")).toEqual([
      {
        role: "system",
        content:
          '<relevant-memories source="tencentdb-agent-memory">\nprefers concise answers\n</relevant-memories>',
      },
    ]);
  });

  it("captures the completed turn after generation", async () => {
    const client = createClient();
    const processor = createMastraMemoryProcessor({ client });
    const messageList = createMessageList();
    await processor.processInput?.(createInputArgs(messageList));
    messageList.add({ role: "assistant", content: "Use a short Markdown list." }, "response");

    const result = await processor.processOutputResult?.(
      createOutputArgs(messageList),
    );

    expect(client.capture).toHaveBeenCalledWith({
      user_content: "How should I format this answer?",
      assistant_content: "Use a short Markdown list.",
      session_key: "mastra:thread-1",
      session_id: "thread-1",
      user_id: "user-1",
    });
    expect(result).toBe(messageList);
  });

  it("does not capture an intermediate tool-call result", async () => {
    const client = createClient();
    const processor = createMastraMemoryProcessor({ client });
    const messageList = createMessageList();
    await processor.processInput?.(createInputArgs(messageList));

    await processor.processOutputResult?.(
      createOutputArgs(messageList, undefined, "tool-calls"),
    );

    expect(client.capture).not.toHaveBeenCalled();
  });

  it("uses authenticated RequestContext identity before client memory metadata", async () => {
    const client = createClient();
    const processor = createMastraMemoryProcessor({ client });
    const messageList = createMessageList("client-thread", "client-user");
    const requestContext = new RequestContext();
    requestContext.set("mastra__threadId", "trusted-thread");
    requestContext.set("mastra__resourceId", "trusted-user");

    await processor.processInput?.(createInputArgs(messageList, requestContext));

    expect(client.recall).toHaveBeenCalledWith({
      query: "How should I format this answer?",
      session_key: "mastra:trusted-thread",
      user_id: "trusted-user",
    });
  });

  it("removes stale recalled context when the next recall is empty", async () => {
    const client = createClient();
    vi.mocked(client.recall).mockResolvedValueOnce({ context: "" });
    const processor = createMastraMemoryProcessor({ client });
    const messageList = createMessageList();
    messageList.addSystem("stale memory", "tencentdb-agent-memory");

    await processor.processInput?.(createInputArgs(messageList));

    expect(messageList.getSystemMessages("tencentdb-agent-memory")).toEqual([]);
  });

  it("fails open when recall or capture is unavailable", async () => {
    const client = createClient();
    vi.mocked(client.recall).mockRejectedValueOnce(new Error("gateway unavailable"));
    vi.mocked(client.capture).mockRejectedValueOnce(new Error("capture unavailable"));
    const onError = vi.fn();
    const processor = createMastraMemoryProcessor({ client, onError });
    const messageList = createMessageList();

    await expect(
      processor.processInput?.(createInputArgs(messageList)),
    ).resolves.toBe(messageList);
    await expect(
      processor.processOutputResult?.(createOutputArgs(messageList)),
    ).resolves.toBe(messageList);
    expect(onError.mock.calls.map(([event]) => event.phase)).toEqual([
      "recall",
      "capture",
    ]);
  });

  it("skips Gateway calls when Mastra has no stable thread identity", async () => {
    const client = createClient();
    const processor = createMastraMemoryProcessor({ client });
    const messageList = new MessageList();
    messageList.add({ role: "user", content: "hello" }, "input");

    await processor.processInput?.(createInputArgs(messageList));

    expect(client.recall).not.toHaveBeenCalled();
    expect(messageList.getSystemMessages("tencentdb-agent-memory")).toEqual([]);
  });

  it("flushes a Mastra thread through the shared Gateway client", async () => {
    const client = createClient();

    const result = await flushMastraSession({
      client,
      threadId: "thread-1",
      resourceId: "user-1",
    });

    expect(client.endSession).toHaveBeenCalledWith({
      session_key: "mastra:thread-1",
      user_id: "user-1",
    });
    expect(result).toEqual({ flushed: true });
  });

  it("fails open when explicit session flush fails", async () => {
    const client = createClient();
    vi.mocked(client.endSession).mockRejectedValueOnce(new Error("flush unavailable"));
    const onError = vi.fn();

    await expect(
      flushMastraSession({
        client,
        threadId: "thread-1",
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "flush" }),
    );
  });
});
