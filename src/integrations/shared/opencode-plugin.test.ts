import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSessionKey,
  createMemoryTencentDBPlugin,
  extractTextFromParts,
} from "../../../integrations/opencode/plugin.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  servers.clear();
});

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

async function startGateway(handler: (
  req: IncomingMessage,
  body: unknown,
  res: ServerResponse,
) => void | Promise<void>) {
  const calls: Array<{
    method: string | undefined;
    url: string | undefined;
    body: any;
  }> = [];
  const server = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    calls.push({ method: req.method, url: req.url, body });
    await handler(req, body, res);
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway did not bind to a TCP port");
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

describe("OpenCode memory plugin helpers", () => {
  it("extracts text from OpenCode text parts", () => {
    expect(extractTextFromParts([
      { type: "text", text: "first" },
      { type: "file", text: "ignored" },
      { type: "text", text: ["second", { text: "third" }] },
    ])).toBe("first\nsecond\nthird");
  });

  it("builds a stable workspace/session key", () => {
    expect(buildSessionKey({ sessionID: "ses_123" }, { directory: "/tmp/demo" }))
      .toMatch(/^opencode:cwd:demo:[a-f0-9]{12}:ses_123$/);
  });
});

describe("OpenCode memory plugin", () => {
  it("recalls memory on chat.message and injects a synthetic memory part", async () => {
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/search/conversations") {
        res.end(JSON.stringify({ results: "", total: 0 }));
        return;
      }
      res.end(JSON.stringify({ context: "OpenCode should remember issue 235 evidence." }));
    });
    const plugin = await createMemoryTencentDBPlugin(
      { directory: "/tmp/opencode-demo", worktree: "/tmp/opencode-demo" },
      { gatewayUrl: gateway.url },
    );
    const output = {
      message: { id: "msg-user" },
      parts: [{ type: "text", text: "What did the adapter prove?" }],
    };

    await plugin["chat.message"]?.({
      sessionID: "session-a",
      messageID: "msg-user",
    }, output as any);

    expect(gateway.calls).toEqual([
      {
        method: "POST",
        url: "/recall",
        body: {
          query: "What did the adapter prove?",
          session_key: expect.stringMatching(/^opencode:cwd:opencode-demo:[a-f0-9]{12}:session-a$/),
        },
      },
      {
        method: "POST",
        url: "/search/conversations",
        body: {
          query: "What did the adapter prove?",
          limit: 3,
          session_key: expect.stringMatching(/^opencode:cwd:opencode-demo:[a-f0-9]{12}:session-a$/),
        },
      },
    ]);
    expect(output.parts[0]).toMatchObject({
      id: expect.stringMatching(/^prt_/),
      type: "text",
      synthetic: true,
    });
    expect(output.parts[0].text).toContain("<relevant-memories");
    expect(output.parts[0].text).toContain("issue 235 evidence");
  });

  it("captures a completed assistant turn from OpenCode message events", async () => {
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/recall") {
        res.end(JSON.stringify({ context: "memory context" }));
        return;
      }
      if (req.url === "/search/conversations") {
        res.end(JSON.stringify({ results: "", total: 0 }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const plugin = await createMemoryTencentDBPlugin(
      { directory: "/tmp/opencode-demo", worktree: "/tmp/opencode-demo" },
      { gatewayUrl: gateway.url },
    );

    await plugin["chat.message"]?.({
      sessionID: "session-b",
      messageID: "user-b",
    }, {
      message: { id: "user-b" },
      parts: [{ type: "text", text: "Remember the OpenCode plugin path." }],
    } as any);
    await plugin.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-b",
            type: "text",
            sessionID: "session-b",
            messageID: "assistant-b",
            text: "The OpenCode plugin path is",
          },
        },
      },
    } as any);
    await plugin.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-b",
            type: "text",
            sessionID: "session-b",
            messageID: "assistant-b",
            text: "The OpenCode plugin path is integrations/opencode/plugin.js.",
          },
        },
      },
    } as any);
    await plugin.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-b",
            role: "assistant",
            sessionID: "session-b",
            time: { completed: Date.now() },
          },
        },
      },
    } as any);

    expect(gateway.calls.map((call) => call.url)).toEqual([
      "/recall",
      "/search/conversations",
      "/capture",
    ]);
    expect(gateway.calls[2].body).toMatchObject({
      user_content: "Remember the OpenCode plugin path.",
      assistant_content: "The OpenCode plugin path is integrations/opencode/plugin.js.",
      session_key: expect.stringMatching(/^opencode:cwd:opencode-demo:[a-f0-9]{12}:session-b$/),
      session_id: "session-b",
      messages: [
        { role: "user", content: "Remember the OpenCode plugin path.", timestamp: expect.any(Number) },
        {
          role: "assistant",
          content: "The OpenCode plugin path is integrations/opencode/plugin.js.",
          timestamp: expect.any(Number),
        },
      ],
      started_at: expect.any(Number),
    });
    expect(gateway.calls[2].body.assistant_content)
      .not.toContain("The OpenCode plugin path is\nThe OpenCode plugin path is");
    expect(gateway.calls[2].body.started_at)
      .toBeLessThan(gateway.calls[2].body.messages[0].timestamp);
  });

  it("flushes a session when assistant text is not available", async () => {
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/recall") {
        res.end(JSON.stringify({ context: "" }));
        return;
      }
      if (req.url === "/search/conversations") {
        res.end(JSON.stringify({ results: "", total: 0 }));
        return;
      }
      res.end(JSON.stringify({ flushed: true }));
    });
    const plugin = await createMemoryTencentDBPlugin(
      { directory: "/tmp/opencode-demo", worktree: "/tmp/opencode-demo" },
      { gatewayUrl: gateway.url },
    );

    await plugin["chat.message"]?.({
      sessionID: "session-c",
      messageID: "user-c",
    }, {
      message: { id: "user-c" },
      parts: [{ type: "text", text: "This turn may not finish." }],
    } as any);
    await plugin.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-c" },
      },
    } as any);

    expect(gateway.calls.map((call) => call.url)).toEqual([
      "/recall",
      "/search/conversations",
      "/session/end",
    ]);
    expect(gateway.calls[2].body).toEqual({
      session_key: expect.stringMatching(/^opencode:cwd:opencode-demo:[a-f0-9]{12}:session-c$/),
    });
  });

  it("waits for idle when completion arrives before the final text part", async () => {
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/recall") {
        res.end(JSON.stringify({ context: "" }));
        return;
      }
      if (req.url === "/search/conversations") {
        res.end(JSON.stringify({ results: "", total: 0 }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const plugin = await createMemoryTencentDBPlugin(
      { directory: "/tmp/opencode-demo" },
      { gatewayUrl: gateway.url },
    );
    await plugin["chat.message"]?.({ sessionID: "session-late", messageID: "user-late" }, {
      message: { id: "user-late" },
      parts: [{ type: "text", text: "Wait for the final part." }],
    } as any);
    await plugin.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-late",
            role: "assistant",
            sessionID: "session-late",
            time: { completed: Date.now() },
          },
        },
      },
    } as any);
    expect(gateway.calls.map((call) => call.url)).toEqual(["/recall", "/search/conversations"]);

    await plugin.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-late",
            type: "text",
            sessionID: "session-late",
            messageID: "assistant-late",
            text: "Final text arrived.",
          },
        },
      },
    } as any);
    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: "session-late" } },
    } as any);

    expect(gateway.calls.filter((call) => call.url === "/capture")).toHaveLength(1);
    expect(gateway.calls.some((call) => call.url === "/session/end")).toBe(false);
  });

  it("flushes an errored session without capturing partial assistant output", async () => {
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/recall") {
        res.end(JSON.stringify({ context: "" }));
        return;
      }
      if (req.url === "/search/conversations") {
        res.end(JSON.stringify({ results: "", total: 0 }));
        return;
      }
      res.end(JSON.stringify({ flushed: true }));
    });
    const plugin = await createMemoryTencentDBPlugin(
      { directory: "/tmp/opencode-demo" },
      { gatewayUrl: gateway.url },
    );
    await plugin["chat.message"]?.({ sessionID: "session-error", messageID: "user-error" }, {
      message: { id: "user-error" },
      parts: [{ type: "text", text: "This response may fail." }],
    } as any);
    await plugin.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "partial",
            type: "text",
            sessionID: "session-error",
            messageID: "assistant-error",
            text: "Partial response",
          },
        },
      },
    } as any);
    await plugin.event?.({
      event: { type: "session.error", properties: { sessionID: "session-error" } },
    } as any);

    expect(gateway.calls.map((call) => call.url)).toEqual([
      "/recall",
      "/search/conversations",
      "/session/end",
    ]);
    expect(gateway.calls.some((call) => call.url === "/capture")).toBe(false);
  });

  it("retains turn state and retries after a transient capture failure", async () => {
    let captureAttempts = 0;
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/recall") {
        res.end(JSON.stringify({ context: "" }));
        return;
      }
      if (req.url === "/search/conversations") {
        res.end(JSON.stringify({ results: "", total: 0 }));
        return;
      }
      if (req.url === "/capture" && captureAttempts++ === 0) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "try again" }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const plugin = await createMemoryTencentDBPlugin(
      { directory: "/tmp/opencode-demo" },
      { gatewayUrl: gateway.url },
    );
    await plugin["chat.message"]?.({ sessionID: "session-retry", messageID: "user-retry" }, {
      message: { id: "user-retry" },
      parts: [{ type: "text", text: "Retry this capture." }],
    } as any);
    await plugin.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-retry",
            type: "text",
            sessionID: "session-retry",
            messageID: "assistant-retry",
            text: "Retried successfully.",
          },
        },
      },
    } as any);
    await plugin.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-retry",
            role: "assistant",
            sessionID: "session-retry",
            time: { completed: Date.now() },
          },
        },
      },
    } as any);
    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: "session-retry" } },
    } as any);

    expect(gateway.calls.filter((call) => call.url === "/capture")).toHaveLength(2);
  });
});
