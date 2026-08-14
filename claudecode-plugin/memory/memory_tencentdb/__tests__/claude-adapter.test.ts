import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClaudeCodeMemoryAdapter } from "../adapter.js";
import {
  deletePrompt,
  getPromptCachePath,
  readPrompt,
  writePrompt,
} from "../prompt-cache.js";
import { readLatestTranscriptTurn } from "../transcript.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tdai-claude-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createClaudeCodeMemoryAdapter", () => {
  it("maps Claude Code sessions through the shared Gateway adapter", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createClaudeCodeMemoryAdapter("claude-session", {
      baseUrl: "http://127.0.0.1:18420/",
      apiKey: "test-token",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ context: "remembered" }), { status: 200 });
      },
    });

    await adapter.prefetch("what is my name?");

    expect(calls[0].url).toBe("http://127.0.0.1:18420/recall");
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      query: "what is my name?",
      session_key: "claude-session",
    });
  });
});

describe("Claude Code prompt cache", () => {
  it("persists prompts without using the session id as a file path", async () => {
    const dir = await tempDir();
    const sessionId = "../../session:with/slashes";

    await writePrompt(sessionId, "remember my name", { dir });
    expect(await readPrompt(sessionId, { dir })).toBe("remember my name");
    expect(path.dirname(getPromptCachePath(sessionId, { dir }))).toBe(dir);
    expect(path.basename(getPromptCachePath(sessionId, { dir }))).not.toContain("session:with");

    await deletePrompt(sessionId, { dir });
    expect(await readPrompt(sessionId, { dir })).toBeNull();
  });

  it("removes stale records", async () => {
    const dir = await tempDir();
    await writePrompt("stale-session", "old prompt", { dir });
    const cachePath = getPromptCachePath("stale-session", { dir });
    const old = new Date(Date.now() - 60_000);
    await utimes(cachePath, old, old);

    expect(await readPrompt("stale-session", { dir, maxAgeMs: 1_000 })).toBeNull();
  });
});

describe("Claude Code transcript fallback", () => {
  it("extracts the latest user and assistant turn from JSONL", async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const records = [
      { message: { role: "user", content: [{ type: "text", text: "first" }] } },
      { message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } },
      { role: "user", content: "remember my name" },
      { role: "assistant", content: [{ text: "I will remember it" }] },
    ];
    await writeFile(transcriptPath, records.map(JSON.stringify).join("\n"), "utf8");

    await expect(readLatestTranscriptTurn(transcriptPath)).resolves.toEqual({
      userText: "remember my name",
      assistantText: "I will remember it",
    });
  });
});
