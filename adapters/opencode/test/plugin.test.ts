import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlugin } from "../src/plugin.js";

const original = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  vi.restoreAllMocks();
});

describe("OpenCode plugin surface", () => {
  it("registers automatic hooks and five native tools with local zero config", async () => {
    for (const key of Object.keys(process.env)) if (key.startsWith("TDAI_")) delete process.env[key];
    const log = vi.fn().mockResolvedValue({});
    const hooks = await createPlugin({
      client: { app: { log }, session: { messages: vi.fn() } },
      directory: "C:/workspace",
    } as never);
    expect(hooks["chat.message"]).toBeTypeOf("function");
    expect(hooks["experimental.chat.system.transform"]).toBeTypeOf("function");
    expect(hooks.event).toBeTypeOf("function");
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "tdai_conversation_search",
      "tdai_memory_search",
      "tdai_memory_status",
      "tdai_skill_read",
      "tdai_skill_search",
    ]);
    const conversationSearch = hooks.tool?.tdai_conversation_search;
    expect(conversationSearch).toBeDefined();
    expect(conversationSearch!.description).toContain("Omit session_id");
    expect(conversationSearch!.description).toContain("Never use the literal value 'current'");
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "s" } as never, output);
    expect(output.system.join("\n")).toContain("automatically captures completed");
    expect(output.system.join("\n")).toContain("do not claim that a memory-write tool is required");
  });

  it("fails open and logs a redacted error for unsafe remote config", async () => {
    process.env.TDAI_MEMORY_ENDPOINT = "http://memory.example";
    const log = vi.fn().mockResolvedValue({});
    const hooks = await createPlugin({ client: { app: { log } } } as never);
    expect(hooks).toEqual({});
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("Bearer");
  });

  it("does not fail plugin initialization when OpenCode logging is unavailable", async () => {
    process.env.TDAI_MEMORY_ENDPOINT = "http://memory.example";
    const hooks = await createPlugin({
      client: { app: { log: vi.fn().mockRejectedValue(new Error("logger offline")) } },
    } as never);
    expect(hooks).toEqual({});
  });
});
