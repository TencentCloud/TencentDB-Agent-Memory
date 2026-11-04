import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { recordConversation, readConversationRecords } from "../src/core/conversation/l0-recorder.js";

type Message = { role: string; content: unknown; [key: string]: unknown };
type Hook = (event: { message: Message }, context?: Record<string, unknown>) => unknown;
const recall = "<relevant-memories>\nA recalled fact that must not become new L0.\n</relevant-memories>";
const question = "What should I work on next?";

describe("local OpenClaw recall history visibility", () => {
  let register: typeof import("../index.js").default;
  let logDir: string;
  beforeAll(async () => {
    logDir = mkdtempSync(path.join(tmpdir(), "recall-visibility-logs-"));
    const previous = process.env.LOG_PATH;
    process.env.LOG_PATH = logDir;
    try { register = (await import("../index.js")).default; }
    finally {
      if (previous === undefined) delete process.env.LOG_PATH;
      else process.env.LOG_PATH = previous;
    }
  });
  afterAll(() => rmSync(logDir, { recursive: true, force: true }));
  const instances: { dir: string; hooks: Map<string, Hook[]>; errors: string[] }[] = [];
  function start(showInjected?: unknown) {
    const dir = mkdtempSync(path.join(tmpdir(), "recall-visibility-"));
    const hooks = new Map<string, Hook[]>();
    const errors: string[] = [];
    instances.push({ dir, hooks, errors });
    register({
      pluginConfig: { mode: "local", recall: { enabled: false, ...(showInjected === undefined ? {} : { showInjected }) },
        capture: { enabled: true }, extraction: { enabled: false }, embedding: { provider: "none" },
        offload: { enabled: false }, report: { enabled: false }, memoryCleanup: { enabled: false }, skill: { enabled: false } },
      config: {}, runtime: { agent: {}, state: { resolveStateDir: () => dir } },
      logger: { info() {}, debug() {}, warn() {}, error(message: string) { errors.push(message); } },
      registerTool() {}, registerCli() {},
      on(name: string, handler: Hook) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    } as unknown as Parameters<typeof register>[0]);
    const handler = hooks.get("before_message_write")?.[0];
    if (!handler) throw new Error("Plugin did not register its message-write hook");
    return { dir, persist(message: Message): Message {
      const result = handler({ message }) as { message: Message } | undefined;
      return result?.message ?? message;
    } };
  }
  afterEach(async () => {
    for (const { dir, hooks, errors } of instances.splice(0)) {
      try {
        for (const stop of hooks.get("gateway_stop") ?? []) await stop({ message: { role: "user", content: "" } });
        expect(errors).toEqual([]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it("preserves recalled context when the user explicitly enables visibility", () => {
    const app = start(true);
    const message = { role: "user", content: `${recall}\n\n${question}`, timestamp: 123 };
    expect(app.persist(message)).toBe(message);
    expect(app.persist(message).content).toBe(`${recall}\n\n${question}`);
  });

  it.each([undefined, false, "true", 1, null])("keeps cleanup enabled unless the option is boolean true (%s)", (option) => {
    const app = start(option);
    const message = { role: "user", content: `${recall}\n\n${question}`, timestamp: 123 };
    expect(app.persist(message)).toEqual({ ...message, content: question });
    expect(message.content).toBe(`${recall}\n\n${question}`);
  });

  it("retains multipart user content and its image attachments when enabled", () => {
    const app = start(true);
    const message = { role: "user", content: [
      { type: "text", text: `${recall}\n${question}`, custom: "keep" },
      { type: "image", data: "image-data", mimeType: "image/png" },
    ] };
    expect(app.persist(message)).toBe(message);
  });

  it("cleans only recall text in multipart content by default, preserving attachments and other fields", () => {
    const app = start();
    const image = { type: "image", data: "image-data", mimeType: "image/png" };
    const unchanged = { type: "text", text: "  deliberate whitespace  " };
    const message = { role: "user", id: "message-id", content: [
      { type: "text", text: `${recall}\n${question}`, custom: "keep" }, image, unchanged,
    ] };
    expect(app.persist(message)).toEqual({ ...message, content: [
      { type: "text", text: question, custom: "keep" }, image, unchanged,
    ] });
    expect(message.content[0]).toMatchObject({ text: `${recall}\n${question}` });
  });

  it.each([true, false])("does not rewrite assistant or tool messages (showInjected=%s)", (option) => {
    const app = start(option);
    for (const role of ["assistant", "tool", "toolResult", "system"]) {
      const message = { role, content: `${recall}\n${question}`, toolCallId: "call-id" };
      expect(app.persist(message)).toBe(message);
    }
  });

  it.each([true, false])("leaves ordinary user content byte-for-byte intact (showInjected=%s)", (option) => {
    const app = start(option);
    for (const content of ["  keep my spacing\n", "", null, [{ type: "image", data: "image-data" }]]) {
      const message = { role: "user", content };
      expect(app.persist(message)).toBe(message);
    }
  });

  it("retains visible recall in the transcript but excludes it from persisted L0", async () => {
    const app = start(true);
    const message = app.persist({ role: "user", content: `${recall}\n${question}`, timestamp: Date.now() });
    expect(message.content).toContain("A recalled fact");
    const baseDir = path.join(app.dir, "memory-tdai");
    const captured = await recordConversation({ sessionKey: "visibility-session", sessionId: "visibility-id",
      userId: "user-a", agentId: "agent-a", rawMessages: [message], baseDir });
    expect(captured.map((m) => m.content)).toEqual([question]);
    const stored = await readConversationRecords("visibility-session", baseDir);
    expect(stored.flatMap((r) => r.messages.map((m) => m.content))).toEqual([question]);
  });

  it("does not create L0 from a visible message containing only recalled context", async () => {
    const app = start(true);
    const message = app.persist({ role: "user", content: recall, timestamp: Date.now() });
    expect(message.content).toBe(recall);
    const baseDir = path.join(app.dir, "memory-tdai");
    expect(await recordConversation({ sessionKey: "recall-only", rawMessages: [message], baseDir })).toEqual([]);
    expect(await readConversationRecords("recall-only", baseDir)).toEqual([]);
  });
});
