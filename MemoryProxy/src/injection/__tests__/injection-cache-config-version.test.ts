import { describe, expect, it } from "vitest";

import type { HookCacheEntry, HookCacheRepo } from "../../db/hookCacheRepo.js";
import type { ContextBlock } from "../types.js";
import type { SessionInfo } from "../../session/types.js";
import { OpenAIAdapter } from "../adapters/openai.js";
import { HookRegistryImpl } from "../registry.js";
import { InjectionPipeline } from "../pipeline.js";
import { prewarmAll } from "../prewarm.js";
import { SkillToolsInjector } from "../injectors/skill-tools-injector.js";
import { TdaiMemoryToolsInjector } from "../injectors/tdai-tools-injector.js";
import { buildHookCacheVariant, hookCacheStorageKey } from "../hook-cache-key.js";

class MemoryHookCacheRepo implements HookCacheRepo {
  private entries = new Map<string, ContextBlock[]>();
  readonly getRequests: string[] = [];

  private key(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): string {
    return [spaceId, userId, agentSource, sessionId, hookId].join("|");
  }

  put(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
    blocks: ContextBlock[],
  ): void {
    this.entries.set(this.key(spaceId, userId, agentSource, sessionId, hookId), blocks);
  }

  putMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    entries: HookCacheEntry[],
  ): void {
    for (const entry of entries) {
      this.put(spaceId, userId, agentSource, sessionId, entry.hookId, entry.blocks);
    }
  }

  async get(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): Promise<ContextBlock[] | null> {
    const key = this.key(spaceId, userId, agentSource, sessionId, hookId);
    this.getRequests.push(key);
    return this.entries.get(key) ?? null;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  async getAllForSession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<HookCacheEntry[]> {
    const prefix = [spaceId, userId, agentSource, sessionId].join("|") + "|";
    return [...this.entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, blocks]) => ({ hookId: key.slice(prefix.length), blocks }));
  }

  clearBySession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): void {
    const prefix = [spaceId, userId, agentSource, sessionId].join("|") + "|";
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

const sessionInfo = {
  session_id: "session-cache-version",
  user_id: "user-test",
  team_id: "team-test",
  agent_id: "agent-test",
} as unknown as SessionInfo;

function pipelineFor(
  hook: Parameters<HookRegistryImpl["register"]>[0],
  repo: HookCacheRepo,
): InjectionPipeline {
  const registry = new HookRegistryImpl();
  registry.register(hook);
  return new InjectionPipeline(
    registry,
    new Map([["openai", new OpenAIAdapter()]]),
    { hookCacheRepo: repo },
  );
}

function metadata() {
  return {
    protocol: "openai" as const,
    traceId: "trace-test",
    keyId: "key-test",
    modelId: "model-test",
    stream: false,
    agentSource: "claude-code",
    userId: "user-test",
    spaceId: "space-test",
    custom: {
      session: {
        session_id: sessionInfo.session_id,
        team_id: sessionInfo.team_id,
        user_id: sessionInfo.user_id,
        agent_id: sessionInfo.agent_id,
      },
    },
  };
}

describe("persistent injection hook cache configuration identity", () => {
  it("reproduces a stale block after externalGatewayUrl changes and restart", async () => {
    const repo = new MemoryHookCacheRepo();
    const oldRegistry = new HookRegistryImpl();
    oldRegistry.register(new SkillToolsInjector({ proxyBaseUrl: "http://old.example:8096" }));

    await prewarmAll(oldRegistry, repo, {
      keyId: "key-test",
      userId: "user-test",
      agentSource: "claude-code",
      spaceId: "space-test",
      sessionInfo,
      agentDetail: null,
      taskDetail: null,
    });

    const newHook = new SkillToolsInjector({ proxyBaseUrl: "https://new.example.com" });
    const newPipeline = pipelineFor(newHook, repo);
    const result = await newPipeline.process(
      {
        messages: [
          { role: "system", content: "base system prompt" },
          { role: "user", content: "hello" },
        ],
      },
      metadata(),
    );

    const systemContent = (result.messages as Array<{ content: string }>)[0].content;
    expect(systemContent).toContain("new.example.com");
    expect(systemContent).not.toContain("old.example");
    expect(repo.keys().some((key) => key.includes("old.example") || key.includes("new.example"))).toBe(false);
    expect(repo.getRequests.at(-1)).not.toBe(repo.keys()[0]);
  });

  it("keeps a cache hit for the same generated configuration", async () => {
    const repo = new MemoryHookCacheRepo();
    const hook = new SkillToolsInjector({ proxyBaseUrl: "https://same.example.com" });
    const registry = new HookRegistryImpl();
    registry.register(hook);
    await prewarmAll(registry, repo, {
      keyId: "key-test",
      userId: "user-test",
      agentSource: "claude-code",
      spaceId: "space-test",
      sessionInfo,
      agentDetail: null,
      taskDetail: null,
    });

    const result = await pipelineFor(
      new SkillToolsInjector({ proxyBaseUrl: "https://same.example.com" }),
      repo,
    ).process(
      { messages: [{ role: "system", content: "base" }, { role: "user", content: "hello" }] },
      metadata(),
    );
    const systemContent = (result.messages as Array<{ content: string }>)[0].content;
    expect(systemContent).toContain("same.example.com");
    expect(repo.getRequests.at(-1)).toBe(repo.keys()[0]);
    expect(repo.getRequests.at(-1)).toContain("skill-tools-injector~v1-");
  });

  it("versions skill-tool blocks when allowLlmWrite changes", async () => {
    const repo = new MemoryHookCacheRepo();
    const oldRegistry = new HookRegistryImpl();
    oldRegistry.register(new SkillToolsInjector({
      proxyBaseUrl: "https://same.example.com",
      allowLlmWrite: false,
    }));
    await prewarmAll(oldRegistry, repo, {
      keyId: "key-test",
      userId: "user-test",
      agentSource: "claude-code",
      spaceId: "space-test",
      sessionInfo,
      agentDetail: null,
      taskDetail: null,
    });

    const result = await pipelineFor(
      new SkillToolsInjector({
        proxyBaseUrl: "https://same.example.com",
        allowLlmWrite: true,
      }),
      repo,
    ).process(
      { messages: [{ role: "system", content: "base" }, { role: "user", content: "hello" }] },
      metadata(),
    );
    const systemContent = (result.messages as Array<{ content: string }>)[0].content;
    expect(systemContent).toContain("skill_create");
    expect(repo.getRequests.at(-1)).not.toBe(repo.keys()[0]);
  });

  it("versions skill-tool blocks when SKILL_VIEW_MODE changes", async () => {
    const previousMode = process.env.SKILL_VIEW_MODE;
    try {
      process.env.SKILL_VIEW_MODE = "id";
      const repo = new MemoryHookCacheRepo();
      const oldRegistry = new HookRegistryImpl();
      oldRegistry.register(new SkillToolsInjector({ proxyBaseUrl: "https://same.example.com" }));
      await prewarmAll(oldRegistry, repo, {
        keyId: "key-test",
        userId: "user-test",
        agentSource: "claude-code",
        spaceId: "space-test",
        sessionInfo,
        agentDetail: null,
        taskDetail: null,
      });

      process.env.SKILL_VIEW_MODE = "name";
      const result = await pipelineFor(
        new SkillToolsInjector({ proxyBaseUrl: "https://same.example.com" }),
        repo,
      ).process(
        { messages: [{ role: "system", content: "base" }, { role: "user", content: "hello" }] },
        metadata(),
      );
      const systemContent = (result.messages as Array<{ content: string }>)[0].content;
      expect(systemContent).toContain('"skill_name"');
      expect(repo.getRequests.at(-1)).not.toBe(repo.keys()[0]);
    } finally {
      if (previousMode === undefined) delete process.env.SKILL_VIEW_MODE;
      else process.env.SKILL_VIEW_MODE = previousMode;
    }
  });

  it("versions tdai tool blocks when the gateway URL changes", async () => {
    const repo = new MemoryHookCacheRepo();
    const oldRegistry = new HookRegistryImpl();
    oldRegistry.register(new TdaiMemoryToolsInjector({ proxyBaseUrl: "http://old.example:8096" }));
    await prewarmAll(oldRegistry, repo, {
      keyId: "key-test",
      userId: "user-test",
      agentSource: "claude-code",
      spaceId: "space-test",
      sessionInfo,
      agentDetail: null,
      taskDetail: null,
    });

    const result = await pipelineFor(
      new TdaiMemoryToolsInjector({ proxyBaseUrl: "https://new.example.com" }),
      repo,
    ).process(
      { messages: [{ role: "system", content: "base" }, { role: "user", content: "hello" }] },
      metadata(),
    );
    const systemContent = (result.messages as Array<{ content: string }>)[0].content;
    expect(systemContent).toContain("new.example.com");
    expect(systemContent).not.toContain("old.example");
    expect(repo.getRequests.at(-1)).not.toBe(repo.keys()[0]);
  });

  it("keeps legacy hooks on their logical id when no variant is declared", () => {
    expect(hookCacheStorageKey({ id: "legacy-hook" })).toBe("legacy-hook");
  });

  it("creates stable opaque variants without embedding configuration values", () => {
    const first = buildHookCacheVariant({
      proxyBaseUrl: "https://gateway.example.com?token=secret",
      allowLlmWrite: false,
    });
    const second = buildHookCacheVariant({
      allowLlmWrite: false,
      proxyBaseUrl: "https://gateway.example.com?token=secret",
    });
    const changed = buildHookCacheVariant({
      proxyBaseUrl: "https://other.example.com",
      allowLlmWrite: false,
    });

    expect(first).toBe(second);
    expect(first).not.toBe(changed);
    expect(first).not.toContain("gateway.example.com");
    expect(first).not.toContain("secret");
  });
});
