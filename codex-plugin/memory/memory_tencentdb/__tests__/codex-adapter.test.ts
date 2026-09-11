import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexMemoryAdapter } from "../adapter.js";
import {
  deletePrompt,
  getPromptCachePath,
  readPrompt,
  writePrompt,
} from "../prompt-cache.js";
import { readLatestTranscriptTurn } from "../transcript.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tdai-codex-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createCodexMemoryAdapter", () => {
  it("maps the Codex session id and Gateway configuration through #316", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createCodexMemoryAdapter("codex-session", {
      baseUrl: "http://127.0.0.1:18420/",
      apiKey: "test-token",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ context: "remembered", memory_count: 1 }), {
          status: 200,
        });
      },
    });

    await adapter.prefetch("what is my name?");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:18420/recall");
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      query: "what is my name?",
      session_key: "codex-session",
    });
  });
});

describe("prompt cache", () => {
  it("persists prompts across calls and keeps session ids out of file paths", async () => {
    const dir = await tempDir();
    const sessionId = "../../session:with/slashes";

    await writePrompt(sessionId, "remember my name", { dir });

    expect(await readPrompt(sessionId, { dir })).toBe("remember my name");
    const cachePath = getPromptCachePath(sessionId, { dir });
    expect(path.dirname(cachePath)).toBe(dir);
    expect(path.basename(cachePath)).not.toContain("session:with");

    await deletePrompt(sessionId, { dir });
    expect(await readPrompt(sessionId, { dir })).toBeNull();
  });

  it("removes stale prompt records", async () => {
    const dir = await tempDir();
    await writePrompt("stale-session", "old prompt", { dir });
    const cachePath = getPromptCachePath("stale-session", { dir });
    const old = new Date(Date.now() - 60_000);
    await utimes(cachePath, old, old);

    expect(await readPrompt("stale-session", { dir, maxAgeMs: 1_000 })).toBeNull();
  });
});

describe("readLatestTranscriptTurn", () => {
  it("extracts the latest user and assistant messages from Codex JSONL", async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const records = [
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "first" }] } },
      { type: "response_item", payload: { role: "assistant", content: [{ type: "output_text", text: "first answer" }] } },
      { role: "user", content: "remember my name" },
      { role: "assistant", content: [{ text: "I will remember it" }] },
    ];
    await writeFile(transcriptPath, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");

    await expect(readLatestTranscriptTurn(transcriptPath)).resolves.toEqual({
      userText: "remember my name",
      assistantText: "I will remember it",
    });
  });

  it("ignores malformed JSONL records", async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      '{not-json}\n{"role":"user","content":"recover me"}\n{"role":"assistant","content":"recovered"}',
      "utf8",
    );

    await expect(readLatestTranscriptTurn(transcriptPath)).resolves.toEqual({
      userText: "recover me",
      assistantText: "recovered",
    });
  });
});
