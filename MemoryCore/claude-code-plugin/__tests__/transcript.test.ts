import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeTranscript,
  promptIdsIn,
  readTranscriptEntries,
  redactSecrets,
  resolveTranscriptPath,
  sliceAfter,
  splitBatches,
  type TranscriptEntry,
} from "../src/hooks/transcript.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tdai-cc-transcript-"));
  tempDirs.push(dir);
  return dir;
}

const user = (uuid: string, content: TranscriptEntry["message"]["content"], extra: Partial<TranscriptEntry> = {}): TranscriptEntry =>
  ({ uuid, type: "user", message: { role: "user", content }, ...extra });
const assistant = (uuid: string, content: TranscriptEntry["message"]["content"], extra: Partial<TranscriptEntry> = {}): TranscriptEntry =>
  ({ uuid, type: "assistant", message: { role: "assistant", content }, ...extra });

const TWO_TURNS: TranscriptEntry[] = [
  user("u1", "fix the build", { promptId: "p1", timestamp: "2026-09-06T01:00:00.000Z" }),
  assistant("a1", [
    { type: "thinking", text: "secret reasoning" },
    { type: "text", text: "Looking at the build." },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
  ], { timestamp: "2026-09-06T01:00:01.000Z" }),
  user("u2", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "1 failing" }] }], { promptId: "p1" }),
  assistant("a2", [{ type: "text", text: "Fixed the failing test." }]),
  user("u3", "now deploy", { promptId: "p2" }),
  assistant("a3", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "make deploy" } }]),
  user("u4", [{ type: "tool_result", tool_use_id: "t2", content: "deployed" }], { promptId: "p2" }),
  assistant("a4", [{ type: "text", text: "Deployed." }]),
];

describe("normalizeTranscript", () => {
  it("turns prompts, tool calls, tool results and assistant text into ordered messages, dropping thinking", () => {
    const messages = normalizeTranscript(TWO_TURNS, { sessionId: "s1" });
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "fix the build"],
      ["assistant", 'Looking at the build.\n[tool_use id=t1 name=Bash input={"command":"npm test"}]'],
      ["user", "[tool_result tool_use_id=t1] 1 failing"],
      ["assistant", "Fixed the failing test."],
      ["user", "now deploy"],
      ["assistant", '[tool_use id=t2 name=Bash input={"command":"make deploy"}]'],
      ["user", "[tool_result tool_use_id=t2] deployed"],
      ["assistant", "Deployed."],
    ]);
    expect(messages[0]).toMatchObject({ id: "claude-code:s1:u1", sourceUuid: "u1", timestamp: "2026-09-06T01:00:00.000Z" });
    expect(messages[2].timestamp).toBeUndefined();
    expect(messages.some((m) => m.content.includes("secret reasoning"))).toBe(false);
  });

  it("leaves out the prompt and final prose of turns already captured, keeping their tool traffic", () => {
    const messages = normalizeTranscript(TWO_TURNS, { sessionId: "s1", capturedPromptIds: new Set(["p2"]) });
    expect(messages.map((m) => m.content)).toEqual([
      "fix the build",
      'Looking at the build.\n[tool_use id=t1 name=Bash input={"command":"npm test"}]',
      "[tool_result tool_use_id=t1] 1 failing",
      "Fixed the failing test.",
      '[tool_use id=t2 name=Bash input={"command":"make deploy"}]',
      "[tool_result tool_use_id=t2] deployed",
    ]);
  });

  it("clips long tool inputs and results and chunks long messages with numbered ids", () => {
    const entries: TranscriptEntry[] = [
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Write", input: { content: "x".repeat(50) } }]),
      user("u1", [{ type: "tool_result", tool_use_id: "t1", content: "y".repeat(50) }]),
      assistant("a2", [{ type: "text", text: "z".repeat(25) }]),
    ];
    const messages = normalizeTranscript(entries, { sessionId: "s1", toolInputMaxChars: 20, toolResultMaxChars: 10, chunkChars: 10 });
    const joined = (uuid: string) => messages.filter((m) => m.sourceUuid === uuid).map((m) => m.content).join("");
    expect(joined("a1")).toContain("… [");
    expect(joined("u1")).toBe(`[tool_result tool_use_id=t1] ${"y".repeat(10)}… [40 more chars]`);
    expect(messages.filter((m) => m.sourceUuid === "a2").map((m) => m.id)).toEqual(["claude-code:s1:a2", "claude-code:s1:a2#1", "claude-code:s1:a2#2"]);
  });

  it("redacts credential-shaped substrings", () => {
    const entries: TranscriptEntry[] = [
      user("u1", "env: TDAI_API_KEY=sk-mem-MiOjHig4avPfKZ6bXRaaVNLKTk8zqdfD OTHER=fine", { promptId: "p1" }),
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "curl -H 'authorization: Bearer gbrain_172b5369fce1b3c48edf059bf6e4b3833f5087849b23682f6713c6d98d6d9f21' http://x" } }]),
      user("u2", [{ type: "tool_result", tool_use_id: "t1", content: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\npassword: hunter2secret\nghp_abcdefghijklmnopqrstuvwxyz0123456789" }]),
    ];
    const contents = normalizeTranscript(entries, { sessionId: "s1" }).map((m) => m.content);
    expect(contents[0]).toBe("env: TDAI_API_KEY=[redacted:secret-key] OTHER=fine");
    expect(contents[1]).toContain("authorization: [redacted:authorization]");
    expect(contents[2]).toContain("[redacted:private-key]");
    expect(contents[2]).toContain("password: [redacted:value]");
    expect(contents[2]).toContain("[redacted:github-token]");
    expect(redactSecrets("plain text stays")).toBe("plain text stays");
  });

  it("drops images and entries that produce no text", () => {
    expect(normalizeTranscript([
      user("u1", [{ type: "image" }]),
      assistant("a1", [{ type: "thinking", text: "only thinking" }]),
      user("u2", "   "),
    ], { sessionId: "s1" })).toEqual([]);
  });
});

describe("transcript files", () => {
  it("reads user and assistant entries only, skipping sidechain, meta, and malformed lines", async () => {
    const file = path.join(await tempDir(), "t.jsonl");
    await writeFile(file, [
      JSON.stringify({ type: "user", uuid: "u1", promptId: "p1", message: { role: "user", content: "hi" } }),
      "not json",
      JSON.stringify({ type: "system", uuid: "s1", content: "hook output" }),
      JSON.stringify({ type: "user", uuid: "u2", isMeta: true, message: { role: "user", content: "injected" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent" }] } }),
      JSON.stringify({ type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
    ].join("\n"));
    const entries = await readTranscriptEntries(file);
    expect(entries.map((e) => e.uuid)).toEqual(["u1", "a2"]);
    expect(promptIdsIn(entries)).toEqual(["p1"]);
  });

  it("slices after a known marker, batches by 100, and resolves the transcript path with a fallback", async () => {
    expect(sliceAfter(TWO_TURNS, "a2").map((e) => e.uuid)).toEqual(["u3", "a3", "u4", "a4"]);
    expect(sliceAfter(TWO_TURNS, "missing")).toHaveLength(TWO_TURNS.length);
    expect(splitBatches(Array.from({ length: 250 }, (_, i) => i)).map((b) => b.length)).toEqual([100, 100, 50]);

    const dir = await tempDir();
    const given = path.join(dir, "given.jsonl");
    await writeFile(given, "");
    await expect(resolveTranscriptPath({ transcriptPath: given, sessionId: "s1" })).resolves.toBe(given);
    const configDir = path.join(dir, "claude");
    const projectDir = path.join(configDir, "projects", "-Users-me-proj-x");
    await mkdir(projectDir, { recursive: true });
    const fallback = path.join(projectDir, "s1.jsonl");
    await writeFile(fallback, "");
    await expect(resolveTranscriptPath({ transcriptPath: path.join(dir, "gone.jsonl"), cwd: "/Users/me/proj.x", sessionId: "s1", claudeConfigDir: configDir })).resolves.toBe(fallback);
    await expect(resolveTranscriptPath({ cwd: "/nowhere", sessionId: "s2", claudeConfigDir: configDir })).resolves.toBeUndefined();
  });
});
