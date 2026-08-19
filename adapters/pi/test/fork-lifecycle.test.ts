import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BRANCH_ENTRY_TYPE, memorySessionId, restoreBranchId } from "../src/session.js";

/**
 * The adapter splits memory by `pi-<sessionId>-<branchId>`, assuming Pi's real
 * fork semantics: a fork is a NEW session id, while a branch keeps the SAME
 * session id and is told apart only by the `tdai-memory/branch@1` marker.
 *
 * Pi has two real fork paths (verified against earendil-works/pi source):
 * - the interactive TUI `/fork` opens the current session file and calls
 *   `createBranchedSession(targetLeafId)` (fork "before" a user message forks
 *   at that message's parent);
 * - the CLI `pi --fork <path>` calls the static `SessionManager.forkFrom`.
 * Both produce a new session id and record the source file as parentSession.
 *
 * These contracts were previously unverified against the real API. This test
 * drives the actual SessionManager class (no Docker, no full Pi TUI) along
 * both real fork paths and the branch path.
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

/** Structurally valid Pi assistant message: its presence makes the session file durable. */
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

/**
 * A two-turn conversation under one branch marker. The file is only written
 * once the first assistant message arrives, and forkTargetId is the entry the
 * TUI `/fork` would branch at for the follow-up turn (its parent).
 */
function seedConversation(session: SessionManager): { firstUserMessageId: string; forkTargetId: string; leafId: string } {
  const firstUser = session.appendMessage(userMessage("origin turn"));
  session.appendMessage(assistantMessage("origin reply"));
  const lastUser = session.appendMessage(userMessage("follow-up"));
  const lastUserEntry = session.getEntry(lastUser);
  session.appendMessage(assistantMessage("follow-up reply"));
  return {
    firstUserMessageId: firstUser,
    forkTargetId: lastUserEntry?.parentId ?? "",
    leafId: session.getLeafId() ?? "",
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("real Pi fork lifecycle", () => {
  it("interactive /fork (createBranchedSession) gets a new session id and keeps the branch marker", async () => {
    const cwd = await tmpDir("tdai-fork-tui-cwd-");
    const sessionDir = await tmpDir("tdai-fork-tui-sessions-");
    const source = SessionManager.create(cwd, sessionDir);
    markBranch(source, "branch-alpha");
    const { forkTargetId } = seedConversation(source);
    const sourceFile = source.getSessionFile();
    expect(sourceFile).toBeTruthy();
    expect(forkTargetId).toBeTruthy();

    // The TUI /fork runtime: open the current session file, then fork.
    const forked = SessionManager.open(sourceFile!, sessionDir);
    forked.createBranchedSession(forkTargetId);

    // New session id: this is what separates the two memory stores.
    expect(forked.getSessionId()).not.toBe(source.getSessionId());
    // The header records the source session file as parent.
    expect(forked.getHeader()?.parentSession).toBe(sourceFile);
    // The forked path keeps the extension's branch marker.
    expect(restoreBranchId(forked.getBranch())).toBe("branch-alpha");
    // Same branch id, different session prefix -> isolated memory session.
    expect(memorySessionId(source.getSessionId(), "branch-alpha")).not.toBe(
      memorySessionId(forked.getSessionId(), "branch-alpha"),
    );
  });

  it("CLI --fork (forkFrom) gets a new session id and keeps the branch marker", async () => {
    const sourceCwd = await tmpDir("tdai-fork-cli-src-cwd-");
    const sessionDir = await tmpDir("tdai-fork-cli-sessions-");
    const source = SessionManager.create(sourceCwd, sessionDir);
    markBranch(source, "branch-alpha");
    seedConversation(source);
    const sourceFile = source.getSessionFile();
    expect(sourceFile).toBeTruthy();

    const targetCwd = await tmpDir("tdai-fork-cli-dst-cwd-");
    const forked = SessionManager.forkFrom(sourceFile!, targetCwd, sessionDir);

    expect(forked.getSessionId()).not.toBe(source.getSessionId());
    expect(forked.getHeader()?.parentSession).toBe(sourceFile);
    expect(restoreBranchId(forked.getBranch())).toBe("branch-alpha");
    expect(memorySessionId(source.getSessionId(), "branch-alpha")).not.toBe(
      memorySessionId(forked.getSessionId(), "branch-alpha"),
    );
  });

  it("two interactive forks of one session are mutually isolated from each other", async () => {
    const cwd = await tmpDir("tdai-fork2-cwd-");
    const sessionDir = await tmpDir("tdai-fork2-sessions-");
    const source = SessionManager.create(cwd, sessionDir);
    markBranch(source, "branch-alpha");
    const { forkTargetId } = seedConversation(source);
    const sourceFile = source.getSessionFile();
    expect(sourceFile).toBeTruthy();

    const forkOne = SessionManager.open(sourceFile!, sessionDir);
    forkOne.createBranchedSession(forkTargetId);
    const forkTwo = SessionManager.open(sourceFile!, sessionDir);
    forkTwo.createBranchedSession(forkTargetId);

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
    const { firstUserMessageId, leafId } = seedConversation(session);

    // Pi's tree navigation: re-edit from the first turn, then a new marker.
    session.branch(firstUserMessageId);
    markBranch(session, "branch-b");
    session.appendMessage(userMessage("alternate turn"));

    // Branching does not change the session id.
    expect(session.getSessionId()).toBe(sessionId);
    // The current leaf resolves the nearest marker on its path.
    expect(restoreBranchId(session.getBranch())).toBe("branch-b");
    // The original path resolves the original marker: the two paths diverge.
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
