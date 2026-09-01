import { describe, expect, it } from "vitest";
import { InjectionPipeline } from "../../pipeline.js";
import { HookRegistryImpl } from "../../registry.js";
import { OpenAIAdapter } from "../../adapters/openai.js";
import { SkillInjector } from "../skill-injector.js";
import { SKILL_QUEUE_START, SKILL_QUEUE_END } from "../../../common/skill-queue-markers.js";

function pipeline(strategy: "every_queue" | "latest_only") {
  const listing = { mode: "full" as const, listing: "<available_skills>\n- demo: current\n</available_skills>", hits: [{ skill_id: "s1", version: 1, name: "demo" }] };
  const client = { listListing: async () => listing };
  const hook = new SkillInjector({
    queueStrategy: strategy,
    coreSkill: { endpoint: "http://core", serviceToken: "token", serviceId: "default", timeoutMs: 1000 },
  }, client as never);
  const registry = new HookRegistryImpl();
  registry.register(hook);
  return new InjectionPipeline(registry, new Map([["openai", new OpenAIAdapter()]]));
}

const metadata = { protocol: "openai" as const, traceId: "t", keyId: "u", modelId: "m", stream: false, agentSource: "test", custom: { session: { team_id: "team", agent_id: "agent" } } };

describe("skill queue strategies in a replayed request", () => {
  it("every_queue emits a marked block on each pipeline execution", async () => {
    const pipe = pipeline("every_queue");
    const first = await pipe.process({ messages: [{ role: "user", content: "first" }] }, metadata);
    const second = await pipe.process({ messages: [...(first.messages as unknown[]), { role: "user", content: "second" }] }, metadata);
    const messages = second.messages as Array<{ content: string }>;
    expect(messages[0].content).toContain(SKILL_QUEUE_START);
    expect(messages[1].content).toContain(SKILL_QUEUE_END);
    expect(messages.filter((m) => m.content.includes(SKILL_QUEUE_START))).toHaveLength(2);
  });

  it("latest_only emits a marked block for the current pipeline queue", async () => {
    const pipe = pipeline("latest_only");
    const first = await pipe.process({ messages: [{ role: "user", content: "first" }] }, metadata);
    const second = await pipe.process({ messages: [...(first.messages as unknown[]), { role: "user", content: "second" }] }, metadata);
    const messages = second.messages as Array<{ content: string }>;
    expect(messages[0].content).toContain(SKILL_QUEUE_START);
    expect(messages[1].content).toContain(SKILL_QUEUE_START);
    expect(messages[1].content).toContain(SKILL_QUEUE_END);
  });
});
