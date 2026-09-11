import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeSessionState, claudeCodeSessionKey } from "./session.js";

const tempDirs: string[] = [];

async function createStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-tencentdb-claude-code-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ClaudeCodeSessionState", () => {
  it("maps the native Claude Code session id to a namespaced session key", () => {
    expect(claudeCodeSessionKey("abc-123")).toBe("claude-code:abc-123");
  });

  it("persists prompts across hook processes and marks captured turns", async () => {
    const stateDir = await createStateDir();
    const firstProcess = new ClaudeCodeSessionState(stateDir);

    await firstProcess.savePrompt("session-1", "prompt-1", "Original prompt");

    const [promptFile] = (await readdir(stateDir)).filter((file) => file.endsWith(".prompt.json"));
    expect(JSON.parse(await readFile(path.join(stateDir, promptFile), "utf-8"))).toEqual({
      sessionId: "session-1",
      promptId: "prompt-1",
      prompt: "Original prompt",
    });

    const secondProcess = new ClaudeCodeSessionState(stateDir);
    expect(await secondProcess.getPrompt("session-1", "prompt-1")).toBe("Original prompt");
    expect(await secondProcess.isCaptured("session-1", "prompt-1")).toBe(false);

    await secondProcess.markCaptured("session-1", "prompt-1");

    const thirdProcess = new ClaudeCodeSessionState(stateDir);
    expect(await thirdProcess.isCaptured("session-1", "prompt-1")).toBe(true);
    expect(await thirdProcess.getPrompt("session-1", "prompt-1")).toBeUndefined();
  });

  it("prevents concurrent capture until the active claim is released", async () => {
    const stateDir = await createStateDir();
    const firstProcess = new ClaudeCodeSessionState(stateDir);
    const secondProcess = new ClaudeCodeSessionState(stateDir);

    expect(await firstProcess.beginCapture("session-1", "prompt-1")).toBe(true);
    expect(await secondProcess.beginCapture("session-1", "prompt-1")).toBe(false);

    await firstProcess.releaseCapture("session-1", "prompt-1");

    expect(await secondProcess.beginCapture("session-1", "prompt-1")).toBe(true);
  });

  it("recovers an expired capture claim", async () => {
    const stateDir = await createStateDir();
    const firstProcess = new ClaudeCodeSessionState(stateDir, { claimTtlMs: 1_000 });
    expect(await firstProcess.beginCapture("session-1", "prompt-1")).toBe(true);

    const [claimFile] = (await readdir(stateDir)).filter((file) => file.endsWith(".capture.claim"));
    const expiredAt = new Date(Date.now() - 2_000);
    const claimPath = path.join(stateDir, claimFile);
    await writeFile(claimPath, JSON.stringify({ pid: "invalid", claimedAt: expiredAt.getTime() }));
    await utimes(claimPath, expiredAt, expiredAt);

    const secondProcess = new ClaudeCodeSessionState(stateDir, { claimTtlMs: 1_000 });
    expect(await secondProcess.beginCapture("session-1", "prompt-1")).toBe(true);
  });

  it("does not reclaim an expired capture claim while its owner process is alive", async () => {
    const stateDir = await createStateDir();
    const firstProcess = new ClaudeCodeSessionState(stateDir, { claimTtlMs: 1_000 });
    expect(await firstProcess.beginCapture("session-1", "prompt-1")).toBe(true);

    const [claimFile] = (await readdir(stateDir)).filter((file) => file.endsWith(".capture.claim"));
    const expiredAt = new Date(Date.now() - 2_000);
    await utimes(path.join(stateDir, claimFile), expiredAt, expiredAt);

    const secondProcess = new ClaudeCodeSessionState(stateDir, { claimTtlMs: 1_000 });
    expect(await secondProcess.beginCapture("session-1", "prompt-1")).toBe(false);
  });

  it("removes turn state older than the configured ttl", async () => {
    const stateDir = await createStateDir();
    const state = new ClaudeCodeSessionState(stateDir, { stateTtlMs: 1_000 });
    await state.savePrompt("session-1", "prompt-1", "Expired prompt");
    await state.markCaptured("session-2", "prompt-2");

    const expiredAt = new Date(Date.now() - 2_000);
    await Promise.all((await readdir(stateDir)).map((file) => utimes(path.join(stateDir, file), expiredAt, expiredAt)));

    await state.cleanupExpiredState();

    expect(await state.getPrompt("session-1", "prompt-1")).toBeUndefined();
    expect(await state.isCaptured("session-2", "prompt-2")).toBe(false);
    expect(await readdir(stateDir)).toEqual([]);
  });

  it("removes abandoned prompt temp files after the state ttl", async () => {
    const stateDir = await createStateDir();
    const state = new ClaudeCodeSessionState(stateDir, { stateTtlMs: 1_000 });
    const tempFile = path.join(
      stateDir,
      `${"a".repeat(64)}.prompt.json.00000000-0000-4000-8000-000000000000.tmp`,
    );
    await writeFile(tempFile, "sensitive prompt", { encoding: "utf-8", mode: 0o600 });
    const expiredAt = new Date(Date.now() - 2_000);
    await utimes(tempFile, expiredAt, expiredAt);

    await state.cleanupExpiredState();

    expect(await readdir(stateDir)).toEqual([]);
  });
});