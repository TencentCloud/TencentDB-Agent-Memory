import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeSessionState, opencodeSessionKey } from "./session.js";

const tempDirs: string[] = [];

async function createStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-tencentdb-opencode-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("OpenCodeSessionState", () => {
  it("maps the native session id to an OpenCode namespace", () => {
    expect(opencodeSessionKey("session-1")).toBe("opencode:session-1");
  });

  it("claims recall once and consumes its context once for the matching session", async () => {
    const stateDir = await createStateDir();
    const firstProcess = new OpenCodeSessionState(stateDir);
    const secondProcess = new OpenCodeSessionState(stateDir);

    expect(await firstProcess.beginRecall("session-1", "user-1")).toBe(true);
    expect(await secondProcess.beginRecall("session-1", "user-1")).toBe(false);

    await firstProcess.saveRecall("session-1", "user-1", "Remember the parser format.");

    expect(await secondProcess.beginRecall("session-1", "user-1")).toBe(false);
    await secondProcess.setActiveRecall("session-1", "user-1");
    expect(await secondProcess.consumeRecall("session-2")).toBeUndefined();
    expect(await secondProcess.consumeRecall("session-1")).toEqual({
      sessionId: "session-1",
      userMessageId: "user-1",
      context: "Remember the parser format.",
    });
    expect(await firstProcess.consumeRecall("session-1")).toBeUndefined();
    expect(await firstProcess.beginRecall("session-1", "user-1")).toBe(false);
  });

  it("releases a failed recall claim for retry", async () => {
    const stateDir = await createStateDir();
    const state = new OpenCodeSessionState(stateDir);

    expect(await state.beginRecall("session-1", "user-1")).toBe(true);
    await state.releaseRecall("session-1", "user-1");
    expect(await state.beginRecall("session-1", "user-1")).toBe(true);
  });

  it("deduplicates capture by the native user and assistant message ids", async () => {
    const stateDir = await createStateDir();
    const firstProcess = new OpenCodeSessionState(stateDir);
    const secondProcess = new OpenCodeSessionState(stateDir);

    expect(await firstProcess.beginCapture("session-1", "user-1", "assistant-1")).toBe(true);
    expect(await secondProcess.beginCapture("session-1", "user-1", "assistant-1")).toBe(false);

    await firstProcess.releaseCapture("session-1", "user-1", "assistant-1");
    expect(await secondProcess.beginCapture("session-1", "user-1", "assistant-1")).toBe(true);
    await secondProcess.markCaptured("session-1", "user-1", "assistant-1");

    expect(await firstProcess.isCaptured("session-1", "user-1", "assistant-1")).toBe(true);
    expect(await firstProcess.beginCapture("session-1", "user-1", "assistant-1")).toBe(false);
    expect(await firstProcess.beginCapture("session-1", "user-1", "assistant-2")).toBe(true);
  });

  it("does not reclaim expired claims while their owner process is alive", async () => {
    const stateDir = await createStateDir();
    const firstProcess = new OpenCodeSessionState(stateDir, { claimTtlMs: 1_000 });
    const secondProcess = new OpenCodeSessionState(stateDir, { claimTtlMs: 1_000 });

    expect(await firstProcess.beginRecall("session-1", "user-1")).toBe(true);
    expect(await firstProcess.beginCapture("session-1", "user-1", "assistant-1")).toBe(true);
    const expiredAt = new Date(Date.now() - 2_000);
    await Promise.all((await readdir(stateDir))
      .filter((file) => file.endsWith(".claim"))
      .map((file) => utimes(path.join(stateDir, file), expiredAt, expiredAt)));

    expect(await secondProcess.beginRecall("session-1", "user-1")).toBe(false);
    expect(await secondProcess.beginCapture("session-1", "user-1", "assistant-1")).toBe(false);
  });

  it("tracks session errors until a new user message clears the gate", async () => {
    const stateDir = await createStateDir();
    const state = new OpenCodeSessionState(stateDir);

    expect(await state.hasSessionError("session-1")).toBe(false);
    await state.markSessionError("session-1");
    expect(await state.hasSessionError("session-1")).toBe(true);
    expect(await state.hasSessionError("session-2")).toBe(false);

    await state.clearSessionError("session-1");
    expect(await state.hasSessionError("session-1")).toBe(false);
  });

  it("clears only transient state owned by the deleted session", async () => {
    const stateDir = await createStateDir();
    const state = new OpenCodeSessionState(stateDir);

    expect(await state.beginRecall("session-1", "user-1")).toBe(true);
    await state.saveRecall("session-1", "user-1", "context-1");
    await state.markSessionError("session-1");
    expect(await state.beginCapture("session-1", "user-1", "assistant-1")).toBe(true);

    expect(await state.beginRecall("session-2", "user-2")).toBe(true);
    await state.saveRecall("session-2", "user-2", "context-2");
    await state.setActiveRecall("session-2", "user-2");

    await state.clearSession("session-1");

    expect(await state.consumeRecall("session-1")).toBeUndefined();
    expect(await state.hasSessionError("session-1")).toBe(false);
    expect(await state.beginCapture("session-1", "user-1", "assistant-1")).toBe(true);
    expect(await state.consumeRecall("session-2")).toEqual({
      sessionId: "session-2",
      userMessageId: "user-2",
      context: "context-2",
    });
  });

  it("removes expired state and abandoned temporary files", async () => {
    const stateDir = await createStateDir();
    const state = new OpenCodeSessionState(stateDir, { stateTtlMs: 1_000, claimTtlMs: 1_000 });

    expect(await state.beginRecall("session-1", "user-1")).toBe(true);
    await state.saveRecall("session-1", "user-1", "expired context");
    await state.markSessionError("session-1");
    expect(await state.beginCapture("session-1", "user-1", "assistant-1")).toBe(true);

    const tempFile = path.join(
      stateDir,
      `${"a".repeat(64)}.${"b".repeat(64)}.recall.json.00000000-0000-4000-8000-000000000000.tmp`,
    );
    await writeFile(tempFile, "sensitive context", { encoding: "utf-8", mode: 0o600 });

    const expiredAt = new Date(Date.now() - 2_000);
    await Promise.all((await readdir(stateDir)).map((file) => utimes(path.join(stateDir, file), expiredAt, expiredAt)));

    await state.cleanupExpiredState();

    expect((await readdir(stateDir)).sort()).toEqual((await readdir(stateDir))
      .filter((file) => file.endsWith(".claim"))
      .sort());
    expect((await readdir(stateDir)).filter((file) => file.endsWith(".capture.claim"))).toHaveLength(1);
  });
});