import { describe, expect, it } from "vitest";

import type { HookCacheEntry, HookCacheRepo } from "../../db/hookCacheRepo.js";
import type { ContextBlock } from "../../injection/types.js";
import {
  __resetSkillQueueMemoryForTests,
  injectDynamicSkillQueue,
} from "../skill-queue-history.js";
import {
  SKILL_QUEUE_END,
  SKILL_QUEUE_START,
  extractMarkedSkillQueueBlock,
} from "../skill-queue-markers.js";

class MemoryRepo implements HookCacheRepo {
  private values = new Map<string, ContextBlock[]>();
  put(_space: string, _user: string, _agent: string, session: string, hook: string, blocks: ContextBlock[]): void {
    this.values.set(`${session}:${hook}`, blocks);
  }
  putMany(_space: string, _user: string, _agent: string, _session: string, _entries: HookCacheEntry[]): void {}
  async get(_space: string, _user: string, _agent: string, session: string, hook: string): Promise<ContextBlock[] | null> {
    return this.values.get(`${session}:${hook}`) ?? null;
  }
  async getAllForSession(): Promise<HookCacheEntry[]> { return []; }
  clearBySession(): void {}
}

const identity = { spaceId: "s", userId: "u", agentSource: "codex", sessionId: "persist" };
const message = (text: string) => ({
  type: "message", role: "user", content: [{ type: "input_text", text }],
});
const buildBlock = (text: string) => ({ type: "input_text", text });

describe("Skill queue Proxy persistence", () => {
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
  });
});
