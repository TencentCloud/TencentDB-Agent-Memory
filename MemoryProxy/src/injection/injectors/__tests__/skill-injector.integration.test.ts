import { describe, expect, it } from "vitest";
import { InjectionPipeline } from "../../pipeline.js";
import { HookRegistryImpl } from "../../registry.js";
import { OpenAIAdapter } from "../../adapters/openai.js";
import { SkillInjector } from "../skill-injector.js";
import { SKILL_QUEUE_START, SKILL_QUEUE_END } from "../../../common/skill-queue-markers.js";

function pipeline(strategy: "every_queue" | "latest_only") {
  const listing = { mode: "full" as const, listing: "<available_skills>\n- demo: current\n</available_skills>", hits: [{ skill_id: "s1", version: 1, name: "demo" }] };
  let calls = 0;
  const client = { listListing: async () => { calls += 1; return listing; } };
  const hook = new SkillInjector({
    queueStrategy: strategy,
    coreSkill: { endpoint: "http://core", serviceToken: "token", serviceId: "default", timeoutMs: 1000 },
  }, client as never);
  const registry = new HookRegistryImpl();
  registry.register(hook);
  return {
    pipe: new InjectionPipeline(registry, new Map([["openai", new OpenAIAdapter()]])),
    calls: () => calls,
  };
}

const metadata = { protocol: "openai" as const, traceId: "t", keyId: "u", modelId: "m", stream: false, agentSource: "test", custom: { session: { team_id: "team", agent_id: "agent" } } };

describe("dynamic skill injector", () => {
  it.each(["every_queue", "latest_only"] as const)("%s emits one marked current block", async (strategy) => {
    const { pipe } = pipeline(strategy);
    const result = await pipe.process({ messages: [{ role: "user", content: "current" }] }, metadata);
    const messages = result.messages as Array<{ content: string }>;
    expect(messages[0].content).toContain(SKILL_QUEUE_START);
    expect(messages[0].content).toContain(SKILL_QUEUE_END);
  });

  it("skips BM25 when every_queue already has the current snapshot", async () => {
    const { pipe, calls } = pipeline("every_queue");
    const result = await pipe.process(
      { messages: [{ role: "user", content: "tool loop" }] },
      { ...metadata, custom: { ...metadata.custom, skillQueueSnapshotHit: true } },
    );

    expect(calls()).toBe(0);
    expect((result.messages as Array<{ content: string }>)[0].content)
      .not.toContain(SKILL_QUEUE_START);
  });
});
