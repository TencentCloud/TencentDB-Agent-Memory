import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import {
  InMemoryTurnStateStore,
  MemoryAdapterRuntime,
  TdaiGatewayClient,
} from "../adapter-sdk/node/index.mjs";

describe("adapter-sdk/node", () => {
  it("runs recall through a single platform adapter interface", async () => {
    const calls: unknown[] = [];
    const runtime = new MemoryAdapterRuntime({
      client: {
        async recall(payload: unknown) {
          calls.push(payload);
          return { context: "remembered context" };
        },
      },
      platform: {
        event: () => "recall",
        session: () => ({ sessionKey: "platform:session", sessionId: "thread-1", userId: "user-1" }),
        recallQuery: () => "what should I remember?",
        injectRecall: (context: string) => ({ injected: context }),
        passThrough: () => ({ pass: true }),
      },
    });

    await expect(runtime.handle({})).resolves.toEqual({ injected: "remembered context" });
    expect(calls).toEqual([
      {
        query: "what should I remember?",
        sessionKey: "platform:session",
        userId: "user-1",
      },
    ]);
  });

  it("runs capture and session end through the same runtime", async () => {
    const calls: Array<[string, unknown]> = [];
    const runtime = new MemoryAdapterRuntime({
      client: {
        async capture(payload: unknown) {
          calls.push(["capture", payload]);
          return { ok: true };
        },
        async endSession(payload: unknown) {
          calls.push(["end", payload]);
          return { flushed: true };
        },
      },
      platform: {
        event: (input: { event: string }) => input.event,
        session: () => ({ sessionKey: "platform:session", sessionId: "thread-1", userId: "user-1" }),
        completedTurn: () => ({
          userText: "user turn",
          assistantText: "assistant turn",
          messages: [
            { role: "user", content: "user turn" },
            { role: "assistant", content: "assistant turn" },
          ],
        }),
        injectRecall: () => null,
        passThrough: () => null,
      },
    });

    await runtime.handle({ event: "capture" });
    await runtime.handle({ event: "session_end" });

    expect(calls).toEqual([
      [
        "capture",
        {
          userText: "user turn",
          assistantText: "assistant turn",
          sessionKey: "platform:session",
          sessionId: "thread-1",
          userId: "user-1",
          messages: [
            { role: "user", content: "user turn" },
            { role: "assistant", content: "assistant turn" },
          ],
        },
      ],
      ["end", { sessionKey: "platform:session", userId: "user-1" }],
    ]);
  });

  it("keeps per-session state in the reusable state store", async () => {
    const store = new InMemoryTurnStateStore();
    await store.mergeSession("s1", { lastUserPrompt: "hello" });
    await store.mergeSession("s1", { lastCaptureAt: "now" });

    await expect(store.readSession("s1")).resolves.toEqual({
      lastUserPrompt: "hello",
      lastCaptureAt: "now",
    });

    await store.deleteSession("s1");
    await expect(store.readSession("s1")).resolves.toEqual({});
  });

  it("maps Gateway routes with the HTTP client", async () => {
    const requests: Array<{ url: string; body: unknown; authorization?: string }> = [];
    const client = new TdaiGatewayClient({
      baseUrl: "http://gateway.local/",
      apiKey: "secret",
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({
          url,
          body: JSON.parse(String(init.body)),
          authorization: init.headers instanceof Headers
            ? init.headers.get("Authorization") ?? undefined
            : (init.headers as Record<string, string>).Authorization,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    await client.recall({ query: "q", sessionKey: "s", userId: "u" });
    await client.capture({ userText: "u1", assistantText: "a1", sessionKey: "s" });
    await client.endSession({ sessionKey: "s", userId: "u" });

    expect(requests.map((r) => r.url)).toEqual([
      "http://gateway.local/recall",
      "http://gateway.local/capture",
      "http://gateway.local/session/end",
    ]);
    expect(requests[0]).toMatchObject({
      body: { query: "q", session_key: "s", user_id: "u" },
      authorization: "Bearer secret",
    });
    expect(requests[1]?.body).toMatchObject({
      user_content: "u1",
      assistant_content: "a1",
      session_key: "s",
    });
  });

  it("ships SDK-based platform adapters in the npm package", () => {
    expect(packageJson.files).toContain("adapter-sdk/");
    expect(packageJson.files).toContain("claude-code-adapter/");
    expect(packageJson.files).toContain("deer-flow-adapter/");
    expect(packageJson.files).toContain("langgraph-adapter/");
  });
});
