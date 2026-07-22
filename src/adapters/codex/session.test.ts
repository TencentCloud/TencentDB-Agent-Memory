import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSessionState, codexSessionKey } from "./session.js";

const tempDirs: string[] = [];

async function createStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-tencentdb-codex-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CodexSessionState", () => {
  it("maps the native Codex session id to a namespaced session key", () => {
    expect(codexSessionKey("abc-123")).toBe("codex:abc-123");
  });

  it("persists prompts across state instances and marks captured turns", async () => {
    const stateDir = await createStateDir();
    const firstProcess = new CodexSessionState(stateDir);

    await firstProcess.savePrompt("session-1", "turn-1", "Original prompt");

    const [promptFile] = (await readdir(stateDir)).filter((file) => file.endsWith(".prompt.json"));
    expect(JSON.parse(await readFile(path.join(stateDir, promptFile), "utf-8"))).toEqual({
      sessionId: "session-1",
      turnId: "turn-1",
      prompt: "Original prompt",
    });

    const secondProcess = new CodexSessionState(stateDir);
    expect(await secondProcess.getPrompt("session-1", "turn-1")).toBe("Original prompt");
    expect(await secondProcess.isCaptured("session-1", "turn-1")).toBe(false);

    await secondProcess.markCaptured("session-1", "turn-1");

    const thirdProcess = new CodexSessionState(stateDir);
    expect(await thirdProcess.isCaptured("session-1", "turn-1")).toBe(true);
    expect(await thirdProcess.getPrompt("session-1", "turn-1")).toBeUndefined();
  });

  it("prevents concurrent capture until the active claim is released", async () => {
    const stateDir = await createStateDir();
    const firstProcess = new CodexSessionState(stateDir);
    const secondProcess = new CodexSessionState(stateDir);

    expect(await firstProcess.beginCapture("session-1", "turn-1")).toBe(true);
    expect(await secondProcess.beginCapture("session-1", "turn-1")).toBe(false);

    await firstProcess.releaseCapture("session-1", "turn-1");

    expect(await secondProcess.beginCapture("session-1", "turn-1")).toBe(true);
  });

  it("recovers an expired capture claim", async () => {
    const stateDir = await createStateDir();
    const firstProcess = new CodexSessionState(stateDir, { claimTtlMs: 1_000 });
    expect(await firstProcess.beginCapture("session-1", "turn-1")).toBe(true);

    const [claimFile] = (await readdir(stateDir)).filter((file) => file.endsWith(".capture.claim"));
    const expiredAt = new Date(Date.now() - 2_000);
    const claimPath = path.join(stateDir, claimFile);
    await writeFile(claimPath, JSON.stringify({ pid: "invalid", claimedAt: expiredAt.getTime() }));
    await utimes(claimPath, expiredAt, expiredAt);

    const secondProcess = new CodexSessionState(stateDir, { claimTtlMs: 1_000 });
    expect(await secondProcess.beginCapture("session-1", "turn-1")).toBe(true);
  });

  it("does not reclaim an expired capture claim while its owner process is alive", async () => {
    const stateDir = await createStateDir();
    const firstProcess = new CodexSessionState(stateDir, { claimTtlMs: 1_000 });
    expect(await firstProcess.beginCapture("session-1", "turn-1")).toBe(true);

    const [claimFile] = (await readdir(stateDir)).filter((file) => file.endsWith(".capture.claim"));
    const expiredAt = new Date(Date.now() - 2_000);
    await utimes(path.join(stateDir, claimFile), expiredAt, expiredAt);

    const secondProcess = new CodexSessionState(stateDir, { claimTtlMs: 1_000 });
    expect(await secondProcess.beginCapture("session-1", "turn-1")).toBe(false);
  });

  it("removes turn state older than the configured ttl", async () => {
    const stateDir = await createStateDir();
    const state = new CodexSessionState(stateDir, { stateTtlMs: 1_000 });
    await state.savePrompt("session-1", "turn-1", "Expired prompt");
    await state.markCaptured("session-2", "turn-2");

    const expiredAt = new Date(Date.now() - 2_000);
    await Promise.all((await readdir(stateDir)).map((file) => utimes(path.join(stateDir, file), expiredAt, expiredAt)));

    await state.cleanupExpiredState();

    expect(await state.getPrompt("session-1", "turn-1")).toBeUndefined();
    expect(await state.isCaptured("session-2", "turn-2")).toBe(false);
    expect(await readdir(stateDir)).toEqual([]);
  });
});