import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BRANCH_ENTRY_TYPE, memorySessionId, restoreBranchId } from "../src/session.js";

/**
 * The adapter relies on Pi's real fork/branch semantics for memory isolation:
 * - a fork (`forkFrom`) is a NEW session file with a NEW session id, so the
 *   first segment of the memory session id changes;
 * - a branch (`branch`) keeps the SAME session id and only moves the leaf
 *   pointer, so sibling branches are told apart solely by the
 *   `tdai-memory/branch@1` marker written on session_tree.
 *
 * These contracts were previously unverified against the real API. This test
 * drives the actual SessionManager class (no Docker, no full Pi TUI) to lock
 * down the behavior the adapter depends on.
 */
const dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Mirror what the adapter does on `session_tree` for a new branch. */
function markBranch(session: SessionManager, branchId: string): string {
  return session.appendCustomEntry(BRANCH_ENTRY_TYPE, {
    branchId,
    createdAt: new Date().toISOString(),
  });
}

/** Structurally valid Pi user message (no import needed; checked inline). */
function userMessage(content: string): { role: "user"; content: string; timestamp: number } {
  return { role: "user", content, timestamp: Date.now() };
}

/** Structurally valid Pi assistant message: its presence makes the outbox file durable. */
function assistantMessage(content: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: content }],
    api: "anthropic",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

/** The session file is only written once an assistant message arrives. */
function seedConversation(session: SessionManager): { userMessageId: string; leafId: string } {
  const userMessageId = session.appendMessage(userMessage("origin turn"));
  session.appendMessage(assistantMessage("origin reply"));
  return { userMessageId, leafId: session.getLeafId() ?? "" };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("real Pi fork lifecycle", () => {
  it("a fork becomes a new session id, remembers its parent, and keeps the branch marker", async () => {
    const sourceCwd = await tmpDir("tdai-fork-src-cwd-");
    const sourceDir = await tmpDir("tdai-fork-src-sessions-");
    const source = SessionManager.create(sourceCwd, sourceDir);
    markBranch(source, "branch-alpha");
    seedConversation(source);
    const sourceFile = source.getSessionFile();
    expect(sourceFile).toBeTruthy();

    const targetCwd = await tmpDir("tdai-fork-dst-cwd-");
    const targetDir = await tmpDir("tdai-fork-dst-sessions-");
    const forked = SessionManager.forkFrom(sourceFile!, targetCwd, targetDir);

    // New session id: this is what separates the two memory stores.
    expect(forked.getSessionId()).not.toBe(source.getSessionId());
    // The header records the source session file as parent.
    expect(forked.getHeader()?.parentSession).toBe(sourceFile);
    // Fork copies the full history, including the extension's branch marker.
    expect(restoreBranchId(forked.getBranch())).toBe("branch-alpha");
    // Same branch id, different session prefix -> isolated memory session.
    expect(memorySessionId(source.getSessionId(), "branch-alpha")).not.toBe(
      memorySessionId(forked.getSessionId(), "branch-alpha"),
    );
  });

  it("two forks of one session are mutually isolated from each other", async () => {
    const sourceCwd = await tmpDir("tdai-fork2-src-cwd-");
    const sessionDir = await tmpDir("tdai-fork2-sessions-");
    const source = SessionManager.create(sourceCwd, sessionDir);
    markBranch(source, "branch-alpha");
    seedConversation(source);
    const sourceFile = source.getSessionFile();
    expect(sourceFile).toBeTruthy();

    const forkOne = SessionManager.forkFrom(sourceFile!, await tmpDir("tdai-fork2-1-cwd-"), sessionDir);
    const forkTwo = SessionManager.forkFrom(sourceFile!, await tmpDir("tdai-fork2-2-cwd-"), sessionDir);

    const memoryIds = new Set(
      [source, forkOne, forkTwo].map((session) => memorySessionId(session.getSessionId(), "branch-alpha")),
    );
    expect(memoryIds.size).toBe(3);
  });

  it("a branch keeps the session id and sibling branches resolve distinct markers", async () => {
    const cwd = await tmpDir("tdai-branch-cwd-");
    const sessionDir = await tmpDir("tdai-branch-sessions-");
    const session = SessionManager.create(cwd, sessionDir);
    const sessionId = session.getSessionId();

    markBranch(session, "branch-a");
    const { userMessageId, leafId } = seedConversation(session);

    // Pi's tree navigation: re-edit from the trunk message, then a new marker.
    session.branch(userMessageId);
    markBranch(session, "branch-b");
    session.appendMessage(userMessage("alternate turn"));

    // Branching does not change the session id.
    expect(session.getSessionId()).toBe(sessionId);
    // The current leaf resolves the nearest marker on its path.
    expect(restoreBranchId(session.getBranch())).toBe("branch-b");
    // The trunk path resolves the original marker: the two paths diverge.
    expect(restoreBranchId(session.getBranch(leafId))).toBe("branch-a");
    // Same session prefix, different branch id -> distinct memory sessions.
    expect(memorySessionId(session.getSessionId(), "branch-a")).not.toBe(
      memorySessionId(session.getSessionId(), "branch-b"),
    );

    // Re-branching from the very root again stays in the same session id.
    session.branch(session.getBranch(leafId)[0]!.id);
    markBranch(session, "branch-c");
    session.appendMessage(userMessage("root re-edit"));
    expect(session.getSessionId()).toBe(sessionId);
    expect(restoreBranchId(session.getBranch())).toBe("branch-c");
  });
});
