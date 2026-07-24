import { describe, expect, it, vi } from "vitest";

import { createClineMemoryPlugin } from "../../cline-adapter/tdai-memory/plugin.js";

function userMessage(text: string) {
  return {
    id: "user-1",
    role: "user",
    content: [{ type: "text", text }],
    createdAt: 1,
  };
}

function snapshot(text: string) {
  return {
    agentId: "agent-1",
    conversationId: "conversation-1",
    status: "running",
    iteration: 0,
    messages: [userMessage(text)],
    pendingToolCalls: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

describe("Cline CLI plugin", () => {
  it("recalls before a run and projects memory into every model request", async () => {
    const runtime = {
      recall: vi.fn().mockResolvedValue("User prefers Rust."),
      capture: vi.fn(),
    };
    const plugin = createClineMemoryPlugin({ runtime });
    const current = snapshot("What language do I prefer?");

    await plugin.hooks.beforeRun({ snapshot: current });
    const first = plugin.hooks.beforeModel({
      snapshot: current,
      request: { messages: current.messages, tools: [] },
    });
    const second = plugin.hooks.beforeModel({
      snapshot: current,
      request: { messages: current.messages, tools: [] },
    });

    expect(runtime.recall).toHaveBeenCalledWith(
      "What language do I prefer?",
      "conversation-1",
    );
    expect(first.messages[0].content[1].text).toContain("User prefers Rust.");
    expect(second.messages[0].content[1].text).toContain("User prefers Rust.");
    expect(current.messages[0].content).toHaveLength(1);
  });

  it("captures a completed run and drops memory state afterwards", async () => {
    const runtime = {
      recall: vi.fn().mockResolvedValue("Earlier context"),
      capture: vi.fn().mockResolvedValue({ l0_recorded: 2 }),
    };
    const plugin = createClineMemoryPlugin({ runtime });
    const current = snapshot("Remember this.");

    await plugin.hooks.beforeRun({ snapshot: current });
    await plugin.hooks.afterRun({
      snapshot: current,
      result: {
        status: "completed",
        outputText: "Remembered.",
        messages: current.messages,
      },
    });
    const after = plugin.hooks.beforeModel({
      snapshot: current,
      request: { messages: current.messages, tools: [] },
    });

    expect(runtime.capture).toHaveBeenCalledWith(
      "Remember this.",
      "Remembered.",
      "conversation-1",
    );
    expect(after).toBeUndefined();
  });

  it("does not capture aborted or failed runs", async () => {
    const runtime = {
      recall: vi.fn().mockResolvedValue(""),
      capture: vi.fn(),
    };
    const plugin = createClineMemoryPlugin({ runtime });
    const current = snapshot("Do work.");

    await plugin.hooks.afterRun({
      snapshot: current,
      result: { status: "aborted", outputText: "", messages: current.messages },
    });

    expect(runtime.capture).not.toHaveBeenCalled();
  });

  it("continues normally when recall and capture return no result", async () => {
    const runtime = {
      recall: vi.fn().mockResolvedValue(""),
      capture: vi.fn().mockResolvedValue(null),
    };
    const plugin = createClineMemoryPlugin({ runtime });
    const current = snapshot("Continue.");

    await expect(
      plugin.hooks.beforeRun({ snapshot: current }),
    ).resolves.toBeUndefined();
    expect(
      plugin.hooks.beforeModel({
        snapshot: current,
        request: { messages: current.messages, tools: [] },
      }),
    ).toBeUndefined();
    await expect(
      plugin.hooks.afterRun({
        snapshot: current,
        result: {
          status: "completed",
          outputText: "Done.",
          messages: current.messages,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails open when the memory runtime throws", async () => {
    const runtime = {
      recall: vi.fn().mockRejectedValue(new Error("Gateway unavailable")),
      capture: vi.fn().mockRejectedValue(new Error("Gateway unavailable")),
    };
    const plugin = createClineMemoryPlugin({ runtime });
    const current = snapshot("Continue without memory.");

    await expect(
      plugin.hooks.beforeRun({ snapshot: current }),
    ).resolves.toBeUndefined();
    expect(
      plugin.hooks.beforeModel({
        snapshot: current,
        request: { messages: current.messages, tools: [] },
      }),
    ).toBeUndefined();
    await expect(
      plugin.hooks.afterRun({
        snapshot: current,
        result: {
          status: "completed",
          outputText: "Completed normally.",
          messages: current.messages,
        },
      }),
    ).resolves.toBeUndefined();
  });
});
