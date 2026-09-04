import { describe, expect, it } from "vitest";

import type { HookCacheEntry, HookCacheRepo } from "../../db/hookCacheRepo.js";
import type { ContextBlock } from "../../injection/types.js";
import {
  __resetSkillQueueMemoryForTests,
  getCurrentSkillQueueSnapshot,
  injectDynamicSkillQueue,
} from "../skill-queue-history.js";
import {
  SKILL_QUEUE_END,
  SKILL_QUEUE_START,
  extractMarkedSkillQueueBlock,
} from "../skill-queue-markers.js";

class MemoryRepo implements HookCacheRepo {
  private values = new Map<string, ContextBlock[]>();
  puts = 0;
  lastSession: string | null = null;
  put(_space: string, _user: string, _agent: string, session: string, hook: string, blocks: ContextBlock[]): void {
    this.puts += 1;
    this.lastSession = session;
    this.values.set(`${session}:${hook}`, blocks);
  }
  putMany(_space: string, _user: string, _agent: string, _session: string, _entries: HookCacheEntry[]): void {}
  async putIfAbsent(_space: string, _user: string, _agent: string, session: string, hook: string, blocks: ContextBlock[]): Promise<boolean> {
    if (this.values.has(`${session}:${hook}`)) return false;
    this.put(_space, _user, _agent, session, hook, blocks);
    return true;
  }
  async get(_space: string, _user: string, _agent: string, session: string, hook: string): Promise<ContextBlock[] | null> {
    return this.values.get(`${session}:${hook}`) ?? null;
  }
  async getAllForSession(): Promise<HookCacheEntry[]> { return []; }
  clearBySession(): void {}
}

class RacingRepo implements HookCacheRepo {
  private reads = 0;

  constructor(private readonly winner: ContextBlock[]) {}

  put(): void {}
  putMany(): void {}
  async putIfAbsent(): Promise<boolean> { return false; }
  async get(): Promise<ContextBlock[] | null> {
    this.reads += 1;
    return this.reads === 1 ? null : this.winner;
  }
  async getAllForSession(): Promise<HookCacheEntry[]> { return []; }
  clearBySession(): void {}
}

const identity = { spaceId: "s", userId: "u", agentSource: "codex", sessionId: "persist" };
const message = (text: string) => ({
  type: "message", role: "user", content: [{ type: "input_text", text }],
});
const buildBlock = (text: string) => ({ type: "input_text", text });

describe("dynamic Skill queue", () => {
  it("extracts the dynamic block from synthetic user.after output", () => {
    const marked = `${SKILL_QUEUE_START}\n<available_skills>x</available_skills>\n${SKILL_QUEUE_END}`;
    expect(extractMarkedSkillQueueBlock(`original user\n${marked}`)).toBe(marked);
  });

  it("reconstructs old suffixes after in-process state is cleared", async () => {
    const repo = new MemoryRepo();
    const firstBlock = `${SKILL_QUEUE_START}\nfirst\n${SKILL_QUEUE_END}`;
    await injectDynamicSkillQueue(
      { input: [message("q1")] }, firstBlock, "every_queue", identity, repo, buildBlock,
    );

    __resetSkillQueueMemoryForTests();
    const secondBlock = `${SKILL_QUEUE_START}\nsecond\n${SKILL_QUEUE_END}`;
    const result = await injectDynamicSkillQueue(
      { input: [message("q1"), message("q2")] },
      secondBlock,
      "every_queue",
      identity,
      repo,
      buildBlock,
    );

    expect((result.input as any[])[0].content[1].text).toBe(firstBlock);
    expect((result.input as any[])[1].content[1].text).toBe(secondBlock);
    expect(repo.lastSession).toBe(identity.sessionId);
  });

  it("keeps the first snapshot immutable and does not rewrite an existing queue", async () => {
    const repo = new MemoryRepo();
    const scopedIdentity = { ...identity, sessionId: "immutable" };
    const firstBlock = `${SKILL_QUEUE_START}\nfirst\n${SKILL_QUEUE_END}`;
    const changedBlock = `${SKILL_QUEUE_START}\nchanged\n${SKILL_QUEUE_END}`;
    await injectDynamicSkillQueue(
      { input: [message("q1")] }, firstBlock, "every_queue", scopedIdentity, repo, buildBlock,
    );
    const result = await injectDynamicSkillQueue(
      { input: [message("q1")] }, changedBlock, "every_queue", scopedIdentity, repo, buildBlock,
    );

    const content = (result.input as any[])[0].content;
    expect(content).toHaveLength(2);
    expect(content[1].text).toBe(firstBlock);
    expect(repo.puts).toBe(1);
  });

  it("uses the persisted winner when another node creates the snapshot first", async () => {
    const winner = `${SKILL_QUEUE_START}\nwinner\n${SKILL_QUEUE_END}`;
    const loser = `${SKILL_QUEUE_START}\nloser\n${SKILL_QUEUE_END}`;
    const repo = new RacingRepo([{ type: "custom", content: winner }]);
    const scopedIdentity = { ...identity, sessionId: "race-winner" };

    __resetSkillQueueMemoryForTests();
    const result = await injectDynamicSkillQueue(
      { input: [message("q1")] }, loser, "every_queue", scopedIdentity, repo, buildBlock,
    );

    expect((result.input as any[])[0].content[1].text).toBe(winner);
  });

  it("exposes an existing snapshot before the pipeline runs", async () => {
    const repo = new MemoryRepo();
    const scopedIdentity = { ...identity, sessionId: "lookup" };
    const block = `${SKILL_QUEUE_START}\ncached\n${SKILL_QUEUE_END}`;
    await injectDynamicSkillQueue(
      { input: [message("q1")] }, block, "every_queue", scopedIdentity, repo, buildBlock,
    );

    await expect(getCurrentSkillQueueSnapshot(
      [message("q1")], scopedIdentity, repo,
    )).resolves.toBe(block);
  });

  it("latest_only strips old marked blocks and targets only the latest queue", async () => {
    const oldBlock = `${SKILL_QUEUE_START}\nold\n${SKILL_QUEUE_END}`;
    const latestBlock = `${SKILL_QUEUE_START}\nlatest\n${SKILL_QUEUE_END}`;
    const first = message("q1");
    first.content.push(buildBlock(oldBlock));
    const result = await injectDynamicSkillQueue(
      { input: [first, message("q2")] },
      latestBlock,
      "latest_only",
      identity,
      undefined,
      buildBlock,
    );

    expect((result.input as any[])[0].content).toHaveLength(1);
    expect((result.input as any[])[1].content[1].text).toBe(latestBlock);
  });
});
