import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryTools } from "../mcp/tools.js";
import { createOpenCodePlugin, OpenCodePlatformAdapter } from "./plugin.js";

const tempDirs: string[] = [];

async function createStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-tencentdb-opencode-plugin-"));
  tempDirs.push(dir);
  return dir;
}

function createTools(overrides: Partial<MemoryTools> = {}): MemoryTools {
  return {
    recall: vi.fn().mockResolvedValue({ context: "", strategy: undefined, memoryCount: 0 }),
    capture: vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true }),
    endSession: vi.fn().mockResolvedValue({ flushed: true }),
    searchMemories: vi.fn(),
    searchConversations: vi.fn(),
    ...overrides,
  } as MemoryTools;
}

function userMessage(id: string, text: string, extraParts: unknown[] = []) {
  return {
    info: { id, sessionID: "session-1", role: "user" as const, time: { created: 1 } },
    parts: [
      { id: `${id}-text`, messageID: id, sessionID: "session-1", type: "text", text },
      ...extraParts,
    ],
  };
}

function assistantMessage(
  id: string,
  parentID: string,
  text: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    info: {
      id,
      sessionID: "session-1",
      role: "assistant" as const,
      parentID,
      time: { created: 2, completed: 3 },
      finish: "stop",
      ...overrides,
    },
    parts: [{ id: `${id}-text`, messageID: id, sessionID: "session-1", type: "text", text }],
  };
}

function createClient(messages: unknown[] = []) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({ data: messages }),
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createOpenCodePlugin", () => {
  it("exposes the OpenCode lifecycle through one platform adapter interface", () => {
    const adapter = new OpenCodePlatformAdapter({
      client: { session: { messages: vi.fn() } },
      directory: "/workspace/project",
    });

    expect(adapter.platform).toBe("opencode");
    expect(typeof adapter.create).toBe("function");
  });

  it("recalls visible user text and injects it once into the matching session", async () => {
    const stateDir = await createStateDir();
    const recall = vi.fn().mockResolvedValue({
      context: "User prefers focused parser changes.",
      strategy: "hybrid",
      memoryCount: 1,
    });
    const plugin = await createOpenCodePlugin(
      { client: createClient(), directory: "/workspace/project" },
      { stateDir, tools: createTools({ recall }) },
    );
    const output = {
      message: { id: "user-1", sessionID: "session-1", role: "user" as const },
      parts: [
        { type: "text", text: "Implement the parser" },
        { type: "text", text: "ignored", ignored: true },
        { type: "text", text: "synthetic", synthetic: true },
      ],
    };

    await plugin["chat.message"]?.({ sessionID: "session-1", messageID: "user-1" }, output);
    await plugin["chat.message"]?.({ sessionID: "session-1", messageID: "user-1" }, output);

    expect(recall).toHaveBeenCalledOnce();
    expect(recall).toHaveBeenCalledWith({
      query: "Implement the parser",
      sessionKey: "opencode:session-1",
    });

    const otherSession = { system: ["base"] };
    await plugin["experimental.chat.system.transform"]?.(
      { sessionID: "session-2", model: {} },
      otherSession,
    );
    expect(otherSession.system).toEqual(["base"]);

    await plugin["experimental.chat.messages.transform"]?.({}, {
      messages: [userMessage("user-1", "Implement the parser")],
    });
    const firstTransform = { system: ["base"] };
    await plugin["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: {} },
      firstTransform,
    );
    expect(firstTransform.system).toEqual([
      "base",
      "<relevant-memories>\nUser prefers focused parser changes.\n</relevant-memories>",
    ]);

    const repeatedTransform = { system: ["base"] };
    await plugin["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: {} },
      repeatedTransform,
    );
    expect(repeatedTransform.system).toEqual(["base"]);
    expect(output.parts).toHaveLength(3);
  });

  it("retries recall after a failure and does not inject empty context", async () => {
    const stateDir = await createStateDir();
    const recall = vi.fn()
      .mockRejectedValueOnce(new Error("gateway down"))
      .mockResolvedValueOnce({ context: "", strategy: undefined, memoryCount: 0 });
    const log = vi.fn();
    const plugin = await createOpenCodePlugin(
      { client: createClient(), directory: "/workspace/project" },
      { stateDir, tools: createTools({ recall }), log },
    );
    const output = {
      message: { id: "user-1", sessionID: "session-1", role: "user" as const },
      parts: [{ type: "text", text: "Retry me" }],
    };

    await plugin["chat.message"]?.({ sessionID: "session-1", messageID: "user-1" }, output);
    await plugin["chat.message"]?.({ sessionID: "session-1", messageID: "user-1" }, output);
    await plugin["chat.message"]?.({ sessionID: "session-1", messageID: "user-1" }, output);

    expect(recall).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("chat message failed open"));
    await plugin["experimental.chat.messages.transform"]?.({}, {
      messages: [userMessage("user-1", "Retry me")],
    });
    const transform = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: {} },
      transform,
    );
    expect(transform.system).toEqual([]);
  });

  it("injects recalled context only once across concurrent transforms", async () => {
    const stateDir = await createStateDir();
    const plugin = await createOpenCodePlugin(
      { client: createClient(), directory: "/workspace/project" },
      {
        stateDir,
        tools: createTools({
          recall: vi.fn().mockResolvedValue({
            context: "Concurrent context",
            strategy: "hybrid",
            memoryCount: 1,
          }),
        }),
      },
    );

    await plugin["chat.message"]?.(
      { sessionID: "session-1", messageID: "user-1" },
      {
        message: { id: "user-1", sessionID: "session-1", role: "user" },
        parts: [{ type: "text", text: "Question" }],
      },
    );

    await plugin["experimental.chat.messages.transform"]?.({}, {
      messages: [userMessage("user-1", "Question")],
    });

    const outputs = [{ system: [] as string[] }, { system: [] as string[] }];
    await Promise.all(outputs.map((output) => plugin["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: {} },
      output,
    )));

    expect(outputs.flatMap((output) => output.system)).toEqual([
      "<relevant-memories>\nConcurrent context\n</relevant-memories>",
    ]);
  });

  it("serializes active recall selection before system injection", async () => {
    const stateDir = await createStateDir();
    const plugin = await createOpenCodePlugin(
      { client: createClient(), directory: "/workspace/project" },
      {
        stateDir,
        tools: createTools({
          recall: vi.fn().mockResolvedValue({
            context: "Serialized context",
            strategy: "hybrid",
            memoryCount: 1,
          }),
        }),
      },
    );

    await plugin["chat.message"]?.(
      { sessionID: "session-1", messageID: "user-1" },
      {
        message: { id: "user-1", sessionID: "session-1", role: "user" },
        parts: [{ type: "text", text: "Question" }],
      },
    );

    const messagesTransform = plugin["experimental.chat.messages.transform"]?.({}, {
      messages: [userMessage("user-1", "Question")],
    });
    const output = { system: [] as string[] };
    const systemTransform = plugin["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: {} },
      output,
    );
    await Promise.all([messagesTransform, systemTransform]);

    expect(output.system).toEqual([
      "<relevant-memories>\nSerialized context\n</relevant-memories>",
    ]);
  });

  it("binds system injection to the user message in the active model context", async () => {
    const stateDir = await createStateDir();
    const recall = vi.fn()
      .mockResolvedValueOnce({ context: "Context A", strategy: "hybrid", memoryCount: 1 })
      .mockResolvedValueOnce({ context: "Context B", strategy: "hybrid", memoryCount: 1 });
    const plugin = await createOpenCodePlugin(
      { client: createClient(), directory: "/workspace/project" },
      { stateDir, tools: createTools({ recall }) },
    );

    for (const [messageID, text] of [["user-a", "No reply context"], ["user-b", "Model context"]]) {
      await plugin["chat.message"]?.(
        { sessionID: "session-1", messageID },
        {
          message: { id: messageID, sessionID: "session-1", role: "user" },
          parts: [{ type: "text", text }],
        },
      );
    }

    await plugin["experimental.chat.messages.transform"]?.({}, {
      messages: [userMessage("user-b", "Model context")],
    });
    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: {} },
      output,
    );

    expect(output.system).toEqual(["<relevant-memories>\nContext B\n</relevant-memories>"]);
  });

  it("fails open when the local state path is unavailable", async () => {
    const statePath = path.join(await createStateDir(), "not-a-directory");
    await writeFile(statePath, "occupied");
    const log = vi.fn();
    const plugin = await createOpenCodePlugin(
      { client: createClient(), directory: "/workspace/project" },
      { stateDir: statePath, tools: createTools(), log },
    );

    await expect(plugin["chat.message"]?.(
      { sessionID: "session-1", messageID: "user-1" },
      {
        message: { id: "user-1", sessionID: "session-1", role: "user" },
        parts: [{ type: "text", text: "Question" }],
      },
    )).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("chat message failed open"));
  });

  it("captures the latest complete parent-linked turn on idle only once", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true });
    const client = createClient([
      userMessage("user-old", "Old question"),
      assistantMessage("assistant-old", "user-old", "Old answer"),
      userMessage("user-1", "Implement the parser"),
      assistantMessage("assistant-1", "user-1", "Implemented the parser."),
    ]);
    const plugin = await createOpenCodePlugin(
      { client, directory: "/workspace/project" },
      { stateDir, tools: createTools({ capture }) },
    );
    const idle = { event: { type: "session.status", properties: { sessionID: "session-1", status: { type: "idle" } } } };

    await plugin.event?.(idle);
    await plugin.event?.(idle);
    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });

    expect(client.session.messages).toHaveBeenCalledWith({
      path: { id: "session-1" },
      query: { directory: "/workspace/project" },
      throwOnError: true,
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith({
      userContent: "Implement the parser",
      assistantContent: "Implemented the parser.",
      sessionKey: "opencode:session-1",
      sessionId: "session-1",
      messages: [
        { id: "opencode:session-1:user-1:user", role: "user", content: "Implement the parser" },
        { id: "opencode:session-1:assistant-1:assistant", role: "assistant", content: "Implemented the parser." },
      ],
    });
  });

  it("does not capture an errored or incomplete latest assistant and does not fall back", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn();
    const client = createClient([
      userMessage("user-old", "Old question"),
      assistantMessage("assistant-old", "user-old", "Old answer"),
      userMessage("user-1", "Latest question"),
      assistantMessage("assistant-1", "user-1", "Partial answer", {
        time: { created: 2 },
        error: { name: "MessageAbortedError" },
      }),
    ]);
    const plugin = await createOpenCodePlugin(
      { client, directory: "/workspace/project" },
      { stateDir, tools: createTools({ capture }) },
    );

    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });

    expect(capture).not.toHaveBeenCalled();
  });
  it("does not capture assistant message with finish: tool-calls", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn();
    const client = createClient([
      userMessage("user-1", "Latest question"),
      assistantMessage("assistant-1", "user-1", "I will read the file first", {
        finish: "tool-calls",
      }),
    ]);
    const plugin = await createOpenCodePlugin(
      { client, directory: "/workspace/project" },
      { stateDir, tools: createTools({ capture }) },
    );

    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });

    expect(capture).not.toHaveBeenCalled();
  });
  it("blocks idle capture after session.error until a new user message", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true });
    const plugin = await createOpenCodePlugin(
      {
        client: createClient([
          userMessage("user-1", "Question"),
          assistantMessage("assistant-1", "user-1", "Answer"),
        ]),
        directory: "/workspace/project",
      },
      { stateDir, tools: createTools({ capture }) },
    );

    await plugin.event?.({ event: { type: "session.error", properties: { sessionID: "session-1" } } });
    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
    expect(capture).not.toHaveBeenCalled();

    await plugin["chat.message"]?.(
      { sessionID: "session-1", messageID: "user-2" },
      {
        message: { id: "user-2", sessionID: "session-1", role: "user" },
        parts: [{ type: "text", text: "Next question" }],
      },
    );
    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
    expect(capture).toHaveBeenCalledOnce();
  });

  it("serializes error, user-message reset, and idle handling for a session", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true });
    const plugin = await createOpenCodePlugin(
      {
        client: createClient([
          userMessage("user-1", "Question"),
          assistantMessage("assistant-1", "user-1", "Answer"),
        ]),
        directory: "/workspace/project",
      },
      { stateDir, tools: createTools({ capture }) },
    );

    const error = plugin.event?.({ event: { type: "session.error", properties: { sessionID: "session-1" } } });
    const nextMessage = plugin["chat.message"]?.(
      { sessionID: "session-1", messageID: "user-2" },
      {
        message: { id: "user-2", sessionID: "session-1", role: "user" },
        parts: [{ type: "text", text: "Next question" }],
      },
    );
    const idle = plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
    await Promise.all([error, nextMessage, idle]);

    expect(capture).toHaveBeenCalledOnce();
  });

  it("retries capture after failure and ends a deleted session fail-open", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn()
      .mockRejectedValueOnce(new Error("capture failed"))
      .mockResolvedValueOnce({ l0Recorded: 2, schedulerNotified: true });
    const endSession = vi.fn().mockRejectedValue(new Error("flush failed"));
    const log = vi.fn();
    const plugin = await createOpenCodePlugin(
      {
        client: createClient([
          userMessage("user-1", "Question"),
          assistantMessage("assistant-1", "user-1", "Answer"),
        ]),
        directory: "/workspace/project",
      },
      { stateDir, tools: createTools({ capture, endSession }), log },
    );

    const idle = { event: { type: "session.idle", properties: { sessionID: "session-1" } } };
    await plugin.event?.(idle);
    await plugin.event?.(idle);
    expect(capture).toHaveBeenCalledTimes(2);

    await expect(plugin.event?.({
      event: { type: "session.deleted", properties: { sessionID: "session-1", info: { id: "session-1" } } },
    })).resolves.toBeUndefined();
    expect(endSession).toHaveBeenCalledWith({ sessionKey: "opencode:session-1" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("session end failed open"));
  });

  it("ends a deleted session only once after a successful flush", async () => {
    const stateDir = await createStateDir();
    const endSession = vi.fn().mockResolvedValue({ flushed: true });
    const plugin = await createOpenCodePlugin(
      { client: createClient(), directory: "/workspace/project" },
      { stateDir, tools: createTools({ endSession }) },
    );
    const deleted = {
      event: { type: "session.deleted", properties: { sessionID: "session-1", info: { id: "session-1" } } },
    };

    await Promise.all([plugin.event?.(deleted), plugin.event?.(deleted)]);

    expect(endSession).toHaveBeenCalledOnce();
  });

  it("dispose waits for deferred capture and endSession before resolving", async () => {
    const stateDir = await createStateDir();
    let resolveCapture!: (value: { l0Recorded: number; schedulerNotified: boolean }) => void;
    let resolveEnd!: (value: { flushed: boolean }) => void;
    const capture = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveCapture = resolve;
    }));
    const endSession = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveEnd = resolve;
    }));
    const plugin = await createOpenCodePlugin(
      {
        client: createClient([
          userMessage("user-1", "Question"),
          assistantMessage("assistant-1", "user-1", "Answer"),
        ]),
        directory: "/workspace/project",
      },
      { stateDir, tools: createTools({ capture, endSession }), disposeTimeoutMs: 2_000 },
    );

    // Start idle capture without awaiting completion.
    void plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());

    // Start session.deleted without awaiting completion.
    void plugin.event?.({
      event: { type: "session.deleted", properties: { sessionID: "session-1", info: { id: "session-1" } } },
    });
    // endSession is queued after capture on the same session queue; release capture first.
    resolveCapture({ l0Recorded: 2, schedulerNotified: true });
    await vi.waitFor(() => expect(endSession).toHaveBeenCalledOnce());

    let disposed = false;
    const disposePromise = plugin.dispose?.().then(() => {
      disposed = true;
    });

    // dispose must not resolve while endSession is still pending.
    await Promise.resolve();
    expect(disposed).toBe(false);

    // Closing rejects new enqueue (different session idle must not start another capture).
    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "session-2" } } });
    expect(capture).toHaveBeenCalledOnce();

    resolveEnd({ flushed: true });
    await disposePromise;
    expect(disposed).toBe(true);
    expect(endSession).toHaveBeenCalledOnce();
  });

  it("dispose times out instead of blocking forever on hung queue work", async () => {
    const stateDir = await createStateDir();
    const log = vi.fn();
    const capture = vi.fn().mockImplementation(() => new Promise(() => {
      // Intentionally never resolves (hung capture).
    }));
    const plugin = await createOpenCodePlugin(
      {
        client: createClient([
          userMessage("user-1", "Question"),
          assistantMessage("assistant-1", "user-1", "Answer"),
        ]),
        directory: "/workspace/project",
      },
      { stateDir, tools: createTools({ capture }), log, disposeTimeoutMs: 50 },
    );

    void plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());

    const started = Date.now();
    await plugin.dispose?.();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1_000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dispose timed out after 50ms"));

    // Closing rejects further enqueue.
    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "session-2" } } });
    expect(capture).toHaveBeenCalledOnce();
  });

  it("dispose is idempotent when called concurrently", async () => {
    const stateDir = await createStateDir();
    let resolveCapture!: (value: { l0Recorded: number; schedulerNotified: boolean }) => void;
    const capture = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveCapture = resolve;
    }));
    const plugin = await createOpenCodePlugin(
      {
        client: createClient([
          userMessage("user-1", "Question"),
          assistantMessage("assistant-1", "user-1", "Answer"),
        ]),
        directory: "/workspace/project",
      },
      { stateDir, tools: createTools({ capture }), disposeTimeoutMs: 2_000 },
    );

    void plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());

    const first = plugin.dispose?.();
    const second = plugin.dispose?.();
    resolveCapture({ l0Recorded: 2, schedulerNotified: true });
    await Promise.all([first, second]);
    expect(capture).toHaveBeenCalledOnce();
  });
});