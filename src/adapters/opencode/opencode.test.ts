import { describe, expect, it, vi } from "vitest";
import {
  buildOpenCodeSessionKey,
  createOpenCodeMemoryPlugin,
  extractOpenCodePrompt,
  type OpenCodePluginHooks,
} from "./index.js";

interface GatewayCall {
  path: string;
  body: Record<string, any>;
}

function gatewayHarness(
  responder: (call: GatewayCall) => { status?: number; body?: unknown } = () => ({}),
) {
  const calls: GatewayCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const call = { path, body };
    calls.push(call);
    const response = responder(call);
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

async function createHooks(
  fetchImpl: typeof fetch,
  log = vi.fn(async () => true),
): Promise<OpenCodePluginHooks> {
  return createOpenCodeMemoryPlugin({
    fetchImpl,
    partIdFactory: () => "prt_memory_test",
  })({
    directory: "/tmp/opencode-project",
    worktree: "/tmp/opencode-project",
    client: { app: { log } },
  });
}

async function sendUserMessage(
  hooks: OpenCodePluginHooks,
  sessionID: string,
  messageID: string,
  text: string,
) {
  const output = {
    message: { id: messageID, sessionID, role: "user" },
    parts: [{ id: `prt_${messageID}`, type: "text", text }],
  };
  await hooks["chat.message"]?.({ sessionID, messageID }, output);
  return output;
}

describe("OpenCode adapter helpers", () => {
  it("builds stable workspace-scoped session keys", () => {
    const first = buildOpenCodeSessionKey({
      sessionID: "ses_a",
      directory: "/tmp/project-a",
    });
    const same = buildOpenCodeSessionKey({
      sessionID: "ses_a",
      directory: "/tmp/project-a",
    });
    const other = buildOpenCodeSessionKey({
      sessionID: "ses_a",
      directory: "/tmp/project-b",
    });

    expect(first).toBe(same);
    expect(first).toMatch(/^opencode:project-a:[a-f0-9]{12}:ses_a$/);
    expect(other).not.toBe(first);
  });

  it("extracts only non-synthetic text parts", () => {
    expect(extractOpenCodePrompt([
      { type: "text", text: "first" },
      { type: "file" },
      { type: "text", text: "memory", synthetic: true },
      { type: "text", text: "second" },
    ])).toBe("first\nsecond");
  });
});

describe("createOpenCodeMemoryPlugin", () => {
  it("recalls before a turn and injects an OpenCode-native synthetic part", async () => {
    const gateway = gatewayHarness(() => ({
      body: { context: "Remember the adapter boundary from issue 455." },
    }));
    const hooks = await createHooks(gateway.fetchImpl);
    const output = await sendUserMessage(hooks, "ses_recall", "msg_user", "What should I remember?");

    expect(gateway.calls).toEqual([{
      path: "/recall",
      body: {
        query: "What should I remember?",
        session_key: expect.stringMatching(/^opencode:opencode-project:[a-f0-9]{12}:ses_recall$/),
      },
    }]);
    expect(output.parts[0]).toMatchObject({
      id: "prt_memory_test",
      sessionID: "ses_recall",
      messageID: "msg_user",
      type: "text",
      synthetic: true,
    });
    expect(output.parts[0].text).toContain("<relevant-memories");
    expect(output.parts[0].text).toContain("issue 455");
  });

  it("captures the exact parent turn and replaces streaming part updates", async () => {
    const gateway = gatewayHarness((call) => ({
      body: call.path === "/recall"
        ? { context: "" }
        : { l0_recorded: 2, scheduler_notified: true },
    }));
    const hooks = await createHooks(gateway.fetchImpl);
    await sendUserMessage(hooks, "ses_capture", "msg_user", "Record this decision.");

    await hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_assistant",
            parentID: "msg_user",
            role: "assistant",
            sessionID: "ses_capture",
            time: { created: Date.now() },
          },
        },
      },
    });
    for (const [id, text] of [
      ["prt_answer", "draft response"],
      ["prt_answer", "final response"],
      ["prt_second", "Second paragraph."],
    ]) {
      await hooks.event?.({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              id,
              messageID: "msg_assistant",
              sessionID: "ses_capture",
              type: "text",
              text,
            },
          },
        },
      });
    }
    await hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_assistant",
            parentID: "msg_user",
            role: "assistant",
            sessionID: "ses_capture",
            time: { created: Date.now(), completed: Date.now() },
          },
        },
      },
    });

    expect(gateway.calls.map((call) => call.path)).toEqual(["/recall", "/capture"]);
    expect(gateway.calls[1].body).toMatchObject({
      user_content: "Record this decision.",
      assistant_content: "final response\nSecond paragraph.",
      session_key: expect.stringMatching(/:ses_capture$/),
      session_id: "ses_capture",
      messages: [
        { role: "user", content: "Record this decision.", timestamp: expect.any(Number) },
        { role: "assistant", content: "final response\nSecond paragraph.", timestamp: expect.any(Number) },
      ],
    });
  });

  it("waits for a late final text part after the completion event", async () => {
    const gateway = gatewayHarness((call) => ({
      body: call.path === "/recall" ? { context: "" } : { l0_recorded: 2 },
    }));
    const hooks = await createHooks(gateway.fetchImpl);
    await sendUserMessage(hooks, "ses_late", "msg_user_late", "Wait for the final part.");
    await hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_assistant_late",
            parentID: "msg_user_late",
            role: "assistant",
            sessionID: "ses_late",
            time: { completed: Date.now() },
          },
        },
      },
    });
    expect(gateway.calls.map((call) => call.path)).toEqual(["/recall"]);

    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_late",
            messageID: "msg_assistant_late",
            sessionID: "ses_late",
            type: "text",
            text: "Now the answer is complete.",
          },
        },
      },
    });

    expect(gateway.calls.map((call) => call.path)).toEqual(["/recall", "/capture"]);
    expect(gateway.calls[1].body.assistant_content).toBe("Now the answer is complete.");
  });

  it("ignores user part events even when they arrive before message metadata", async () => {
    const gateway = gatewayHarness((call) => ({
      body: call.path === "/recall" ? { context: "" } : { l0_recorded: 2 },
    }));
    const hooks = await createHooks(gateway.fetchImpl);
    await sendUserMessage(hooks, "ses_roles", "msg_user_roles", "user text");
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_user",
            messageID: "msg_user_roles",
            sessionID: "ses_roles",
            type: "text",
            text: "must not become assistant text",
          },
        },
      },
    });
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_assistant",
            messageID: "msg_assistant_roles",
            sessionID: "ses_roles",
            type: "text",
            text: "assistant text",
          },
        },
      },
    });
    await hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_assistant_roles",
            parentID: "msg_user_roles",
            role: "assistant",
            sessionID: "ses_roles",
            time: { completed: Date.now() },
          },
        },
      },
    });

    expect(gateway.calls.at(-1)?.body.assistant_content).toBe("assistant text");
  });

  it("uses assistant parent ids when turns overlap in one session", async () => {
    const gateway = gatewayHarness((call) => ({
      body: call.path === "/recall" ? { context: "" } : { l0_recorded: 2 },
    }));
    const hooks = await createHooks(gateway.fetchImpl);
    await sendUserMessage(hooks, "ses_parallel", "msg_user_a", "first prompt");
    await sendUserMessage(hooks, "ses_parallel", "msg_user_b", "second prompt");

    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_a",
            messageID: "msg_assistant_a",
            sessionID: "ses_parallel",
            type: "text",
            text: "first answer",
          },
        },
      },
    });
    await hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_assistant_a",
            parentID: "msg_user_a",
            role: "assistant",
            sessionID: "ses_parallel",
            time: { completed: Date.now() },
          },
        },
      },
    });

    expect(gateway.calls[2].path).toBe("/capture");
    expect(gateway.calls[2].body.user_content).toBe("first prompt");
    expect(gateway.calls[2].body.assistant_content).toBe("first answer");
  });

  it("fails open when recall is unavailable and reports through OpenCode logging", async () => {
    const gateway = gatewayHarness(() => ({ status: 503, body: { error: "offline" } }));
    const log = vi.fn(async () => true);
    const hooks = await createHooks(gateway.fetchImpl, log);
    const output = await sendUserMessage(hooks, "ses_offline", "msg_offline", "Keep working.");

    expect(output.parts).toHaveLength(1);
    expect(log).toHaveBeenCalledWith({
      body: expect.objectContaining({
        service: "memory-tencentdb-opencode",
        level: "warn",
        message: "Failed to recall memory for OpenCode turn",
      }),
    });
  });

  it("flushes only when OpenCode deletes the session", async () => {
    const gateway = gatewayHarness((call) => ({
      body: call.path === "/recall" ? { context: "" } : { flushed: true },
    }));
    const hooks = await createHooks(gateway.fetchImpl);
    await sendUserMessage(hooks, "ses_delete", "msg_delete", "This turn is incomplete.");
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "ses_delete" },
      },
    });
    expect(gateway.calls.map((call) => call.path)).toEqual(["/recall"]);

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_delete" } },
      },
    });
    expect(gateway.calls.map((call) => call.path)).toEqual(["/recall", "/session/end"]);
    expect(gateway.calls[1].body.session_key).toMatch(/:ses_delete$/);
  });

  it("discards an errored turn but keeps the session available for later flush", async () => {
    const gateway = gatewayHarness((call) => ({
      body: call.path === "/recall" ? { context: "" } : { flushed: true },
    }));
    const hooks = await createHooks(gateway.fetchImpl);
    await sendUserMessage(hooks, "ses_error", "msg_error", "This turn fails.");
    await hooks.event?.({
      event: {
        type: "session.error",
        properties: { sessionID: "ses_error", error: { name: "APIError" } },
      },
    });
    await hooks.dispose?.();

    expect(gateway.calls.map((call) => call.path)).toEqual(["/recall", "/session/end"]);
  });
});
