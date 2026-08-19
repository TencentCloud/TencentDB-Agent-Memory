import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TDAMError } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { cleanupSkillDead, createSkillMessages, enqueueSkillTurn, retrySkillPending } from "../src/skill-capture.js";
import { redactValue } from "../src/security.js";
import type { LoadedConfig, SkillsOptions } from "../src/types.js";

const conversationAdd = vi.fn();
vi.mock("../src/clients.js", () => ({
  createClients: () => ({ skill: { conversationAdd } }),
  createSessionMemoryClient: () => ({}),
}));

const skills: SkillsOptions = {
  enabled: true,
  capture: true,
  runtimeTools: true,
  routingMode: "bm25",
  allowTeamSearch: false,
  includeFailedTools: false,
  maxMessageBytes: 32_768,
  maxToolItems: 16,
  flushTimeoutMs: 1_500,
};

const config: LoadedConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:8420",
  serviceId: "default",
  teamId: "team-test",
  agentId: "agent-test",
  userId: "user-test",
  userKey: "sk-mem-test",
  gatewayApiKey: "gateway-test",
  timeoutMs: 1_000,
  rejectUnauthorized: true,
  captureTools: false,
  recall: { enabled: true, deadlineMs: 3_000, l0Limit: 4, l1Limit: 6, l2Limit: 2, maxChars: 12_000 },
  skills,
  sources: [],
  userKeySource: "test",
  gatewayApiKeySource: "test",
};

const directories: string[] = [];
afterEach(async () => {
  conversationAdd.mockReset();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createSkillMessages", () => {
  it("normalises user -> paired tool_call/tool_result -> assistant", () => {
    const messages = createSkillMessages({
      prompt: "deploy the service",
      finalAssistant: "deployed",
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "bash",
          input: { command: "pnpm build" },
          result: { content: [{ type: "text", text: "built ok" }], isError: false },
        },
      ],
      options: skills,
    });

    expect(messages.map((message) => message.role)).toEqual(["user", "tool_call", "tool_result", "assistant"]);
    expect(messages[1]).toMatchObject({ role: "tool_call", tool_call_id: "call-1", tool_name: "bash" });
    expect(messages[1]!.content).toContain("pnpm build");
    expect(messages[2]).toMatchObject({ role: "tool_result", tool_call_id: "call-1", tool_name: "bash" });
    expect(messages[2]!.content).toContain("built ok");
    expect(messages[3]!.content).toBe("deployed");
  });

  it("drops an incomplete pair rather than synthesising a fake result", () => {
    const messages = createSkillMessages({
      prompt: "q",
      finalAssistant: "a",
      toolCalls: [
        { toolCallId: "call-1", toolName: "bash", input: { command: "ls" } }, // no result
        { toolCallId: "call-2", toolName: "read", input: { path: "x" }, result: { content: [{ type: "text", text: "ok" }], isError: false } },
      ],
      options: skills,
    });
    expect(messages.map((message) => message.role)).toEqual(["user", "tool_call", "tool_result", "assistant"]);
    expect(messages.some((message) => message.tool_call_id === "call-1")).toBe(false);
  });

  it("drops failed tools by default but keeps them when opted in", () => {
    const call = {
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "false" },
      result: { content: [{ type: "text", text: "exit 1" }], isError: true },
    };
    const dropped = createSkillMessages({ prompt: "q", finalAssistant: "a", toolCalls: [call], options: skills });
    expect(dropped.some((message) => message.role === "tool_call")).toBe(false);

    const kept = createSkillMessages({
      prompt: "q",
      finalAssistant: "a",
      toolCalls: [call],
      options: { ...skills, includeFailedTools: true },
    });
    expect(kept.some((message) => message.role === "tool_call")).toBe(true);
    expect(kept.some((message) => message.role === "tool_result")).toBe(true);
  });

  it("redacts sensitive tool arguments and text blocks", () => {
    const messages = createSkillMessages({
      prompt: "auth with sk-mem-abcdefghijklmnopqrstuvwxyz",
      finalAssistant: "done",
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "bash",
          input: { command: "curl", env: { PASSWORD: "hunter2", apiKey: "secret" } },
          result: { content: [{ type: "text", text: "token sk-live-abcdefghijklmnop" }], isError: false },
        },
      ],
      options: skills,
    });
    const user = messages[0]!.content;
    expect(user).not.toContain("sk-mem-abcdefghijklmnop");
    const callContent = messages.find((message) => message.role === "tool_call")!.content;
    expect(callContent).toContain("[REDACTED]");
    expect(callContent).not.toContain("hunter2");
    expect(callContent).not.toContain("secret");
    const resultContent = messages.find((message) => message.role === "tool_result")!.content;
    expect(resultContent).not.toContain("sk-live-abcdefghijklmnop");
  });

  it("bounds each message to maxMessageBytes", () => {
    const long = "x".repeat(10_000);
    const messages = createSkillMessages({
      prompt: long,
      finalAssistant: "done",
      toolCalls: [
        { toolCallId: "c1", toolName: "bash", input: { command: long }, result: { content: [{ type: "text", text: long }], isError: false } },
      ],
      options: { ...skills, maxMessageBytes: 1_024 },
    });
    for (const message of messages) {
      expect(Buffer.byteLength(message.content)).toBeLessThanOrEqual(1_024);
    }
  });
});

describe("enqueueSkillTurn", () => {
  it("delivers once and removes the pending record on ok", async () => {
    conversationAdd.mockResolvedValue({ status: "ok" });
    const directory = await mkdtemp(join(tmpdir(), "tdai-skill-test-"));
    directories.push(directory);

    const status = await enqueueSkillTurn(config, "pi-session", [{ role: "user", content: "hello" }], { directory });
    expect(status).toBe("delivered");
    expect(conversationAdd).toHaveBeenCalledTimes(1);
    const files = await readdir(directory);
    expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(0);
  });

  it("reports archived and removes the record", async () => {
    conversationAdd.mockResolvedValue({ status: "archived", archived: { task_id: "t1", archived_at_ms: 1, archive_key: "k", reason: "tool_calls" } });
    const directory = await mkdtemp(join(tmpdir(), "tdai-skill-test-"));
    directories.push(directory);

    const status = await enqueueSkillTurn(config, "pi-session", [{ role: "user", content: "hello" }], { directory });
    expect(status).toBe("archived");
  });

  it("quarantines a deterministic 4xx as dead", async () => {
    conversationAdd.mockRejectedValue(new TDAMError(40001, "invalid message", "req-1"));
    const directory = await mkdtemp(join(tmpdir(), "tdai-skill-test-"));
    directories.push(directory);

    const status = await enqueueSkillTurn(config, "pi-session", [{ role: "user", content: "hello" }], { directory });
    expect(status).toBe("dead");
    const files = await readdir(directory);
    expect(files.some((name) => name.endsWith(".json.dead"))).toBe(true);
  });

  it("keeps an ambiguous failure as uncertain and never retries", async () => {
    conversationAdd.mockRejectedValue(new Error("fetch failed"));
    const directory = await mkdtemp(join(tmpdir(), "tdai-skill-test-"));
    directories.push(directory);

    const status = await enqueueSkillTurn(config, "pi-session", [{ role: "user", content: "hello" }], { directory });
    expect(status).toBe("uncertain");
    expect(conversationAdd).toHaveBeenCalledTimes(1);
    const files = await readdir(directory);
    const pending = files.filter((name) => name.endsWith(".json"));
    expect(pending).toHaveLength(1);
    const record = JSON.parse(await readFile(join(directory, pending[0]!), "utf8")) as { uncertain?: boolean };
    expect(record.uncertain).toBe(true);
  });

  it("marks a timeout as uncertain", async () => {
    conversationAdd.mockImplementation(() => new Promise(() => undefined));
    const directory = await mkdtemp(join(tmpdir(), "tdai-skill-test-"));
    directories.push(directory);

    const timedConfig = { ...config, skills: { ...skills, flushTimeoutMs: 25 } };
    const status = await enqueueSkillTurn(timedConfig, "pi-session", [{ role: "user", content: "hello" }], { directory });
    expect(status).toBe("uncertain");
  });

  it("is a no-op for an empty message list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tdai-skill-test-"));
    directories.push(directory);
    const status = await enqueueSkillTurn(config, "pi-session", [], { directory });
    expect(status).toBe("delivered");
    expect(conversationAdd).not.toHaveBeenCalled();
    expect(await readdir(directory)).toHaveLength(0);
  });
});

describe("manual Skill recovery", () => {
  it("retries an uncertain record and removes it after success", async () => {
    conversationAdd.mockRejectedValueOnce(new Error("connection lost"));
    const directory = await mkdtemp(join(tmpdir(), "tdai-skill-test-"));
    directories.push(directory);

    const first = await enqueueSkillTurn(config, "pi-session", [{ role: "user", content: "hello" }], { directory });
    expect(first).toBe("uncertain");

    conversationAdd.mockResolvedValueOnce({ status: "ok" });
    const result = await retrySkillPending(config, { directory });

    expect(result).toMatchObject({ retried: 1, delivered: 1, uncertain: 0, dead: 0 });
    expect(conversationAdd).toHaveBeenCalledTimes(2);
    expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toHaveLength(0);
  });

  it("keeps an uncertain record when the explicit retry is still ambiguous", async () => {
    conversationAdd.mockRejectedValueOnce(new Error("connection lost"));
    const directory = await mkdtemp(join(tmpdir(), "tdai-skill-test-"));
    directories.push(directory);

    await enqueueSkillTurn(config, "pi-session", [{ role: "user", content: "hello" }], { directory });
    conversationAdd.mockRejectedValueOnce(new Error("still offline"));

    const result = await retrySkillPending(config, { directory });
    expect(result).toMatchObject({ retried: 1, delivered: 0, uncertain: 1, dead: 0 });
    const pending = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    expect(pending).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, pending[0]!), "utf8"))).toMatchObject({ uncertain: true });
  });

  it("cleans only dead records belonging to the active identity", async () => {
    conversationAdd.mockRejectedValueOnce(new TDAMError(40001, "invalid message", "req-current"));
    const directory = await mkdtemp(join(tmpdir(), "tdai-skill-test-"));
    directories.push(directory);

    await enqueueSkillTurn(config, "pi-session", [{ role: "user", content: "current" }], { directory });
    const otherScopeRecord = {
      version: 1,
      id: "other-record",
      createdAt: "2026-08-19T00:00:00.000Z",
      scope: JSON.stringify({ ...JSON.parse(configScope(config)), agentId: "other-agent" }),
      sessionId: "other-session",
      messages: [{ role: "user", content: "other" }],
    };
    await writeFile(join(directory, "other.json.dead"), `${JSON.stringify(otherScopeRecord)}\n`, "utf8");

    const result = await cleanupSkillDead(config, { directory });
    expect(result.removed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(await readdir(directory)).toEqual(["other.json.dead"]);
  });
});

function configScope(value: LoadedConfig): string {
  return JSON.stringify({
    endpoint: value.endpoint,
    serviceId: value.serviceId,
    teamId: value.teamId,
    agentId: value.agentId,
    userId: value.userId,
  });
}

describe("redactValue", () => {
  it("redacts nested objects and arrays recursively", () => {
    const value = { a: { b: "sk-mem-abcdefghijklmnopqrstuvwxyz", c: [{ d: "plain" }] } };
    const redacted = redactValue(value) as { a: { b: string; c: Array<{ d: string }> } };
    expect(redacted.a.b).toBe("[REDACTED]");
    expect(redacted.a.c[0]!.d).toBe("plain");
  });

  it("blanks whole values under sensitive keys even without a secret prefix", () => {
    const redacted = redactValue({ password: "hunter2", api_key: "x", token: "uuid", normal: "kept" }) as Record<string, string>;
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.api_key).toBe("[REDACTED]");
    expect(redacted.token).toBe("[REDACTED]");
    expect(redacted.normal).toBe("kept");
  });

  it("bounds recursion depth", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    const redacted = redactValue(deep) as { next: unknown };
    expect(JSON.stringify(redacted)).toContain("[...]");
  });
});
