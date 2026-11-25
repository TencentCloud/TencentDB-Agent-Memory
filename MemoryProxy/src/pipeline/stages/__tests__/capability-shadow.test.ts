import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../../config.js";
import { registerSelectionStrategy, resetSelectionStrategies } from "../../../selection/registry.js";
import type { SelectionInput, SelectionOutcome } from "../../../selection/types.js";
import { CoreSkillClient, setCoreSkillClient } from "../../../skill/core-client.js";
import { observeCapabilityRouting } from "../capability-shadow.js";
import { stageInjectionRunner } from "../injection-runner.js";
import type { InjectionRunnerInput } from "../injection-runner.js";

function request(): InjectionRunnerInput {
  const messages = [{ role: "user", content: "Find the previous release notes." }];
  return {
    config: {
      ...DEFAULT_CONFIG,
      capabilityRouting: {
        enabled: true, strategy: "fixture", topK: 12, secondPassTopK: 50,
        contextCharBudget: 600, criteriaCharBudget: 1200,
      },
      injection: { ...DEFAULT_CONFIG.injection, enabled: false },
    },
    body: {
      messages,
      tools: [{ type: "function", function: {
        name: "list_releases", description: "List releases", parameters: { type: "object" },
      } }],
    },
    messages,
    skip: false, protocol: "openai", traceId: "fixture-trace", keyId: "fixture-key",
    modelId: "fixture-model", isStream: false, agentSource: "dsh",
    userId: "user-a", spaceId: "space-a", sessionKey: "same-session", requestPath: "/test",
    sessionInfo: { user_id: "user-a", space_id: "space-a", team_id: "team-a", agent_id: "agent-a" },
  };
}

function registerFixture(select: (input: SelectionInput) => Promise<SelectionOutcome>) {
  registerSelectionStrategy("fixture", () => ({
    name: "fixture", model: "fixture-model", isUsable: () => true, select,
  }));
}

afterEach(() => {
  resetSelectionStrategies();
  setCoreSkillClient(null);
});

describe("capability routing at the injection stage", () => {
  it("leaves forwarding unchanged while a decision is still pending", async () => {
    const input = request();
    let finish!: (outcome: SelectionOutcome) => void;
    let started!: () => void;
    const inFlight = new Promise<SelectionOutcome>((resolve) => { finish = resolve; });
    const observed = new Promise<void>((resolve) => { started = resolve; });
    registerFixture(() => {
      started();
      return inFlight;
    });
    try {
      const forwarded = await stageInjectionRunner(input);
      expect(forwarded.body).toBe(input.body);
      expect(forwarded.messages).toBe(input.messages);
      await observed;
    } finally {
      finish({ kind: "none" });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

  it("rejects cross-user and cross-instance bindings, forks and forced tool choices", async () => {
    const select = vi.fn(async (): Promise<SelectionOutcome> => ({ kind: "none" }));
    registerFixture(select);
    const input = request();
    await observeCapabilityRouting({ ...input, userId: "somebody-else" });
    await observeCapabilityRouting({ ...input, spaceId: "space-b" });
    await observeCapabilityRouting({ ...input, skip: true });
    await observeCapabilityRouting({ ...input, readOnly: true });
    await observeCapabilityRouting({ ...input, body: { ...input.body, tool_choice: "required" } });
    await observeCapabilityRouting({ ...input, messages: [{ role: "tool", content: "Completed" }] });
    expect(select).not.toHaveBeenCalled();
  });

  it("uses bound tenant scope for Skill candidates and eligible Anthropic tool schemas", async () => {
    const input = request();
    input.config.coreSkill = { ...input.config.coreSkill, serviceToken: "fixture-service-token" };
    input.assetCapabilities = { skill: true, chat_memory: false, code_graph: false, llm_wiki: false };
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body));
      const space = new Headers(init?.headers).get("x-tdai-service-id");
      expect(body).toMatchObject({ team_id: "team-a", agent_id: "agent-a", mode: "hybrid" });
      return Response.json({ code: 0, data: {
        items: [{ skill_id: "same-id", name: "Release guide " + space, description: "Review releases", version: 1 }],
      } });
    });
    setCoreSkillClient(new CoreSkillClient(input.config.coreSkill, fetcher));
    const select = vi.fn(async (_input: SelectionInput): Promise<SelectionOutcome> => ({ kind: "none" }));
    registerFixture(select);

    await observeCapabilityRouting({
      ...input,
      protocol: "anthropic",
      body: { ...input.body, tools: [{
        name: "list_releases", description: "List releases", input_schema: { type: "object" },
      }], tool_choice: { type: "auto" } },
    });
    await observeCapabilityRouting({
      ...input, spaceId: "space-b",
      sessionInfo: { ...input.sessionInfo, space_id: "space-b" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const labels = select.mock.calls.map(([arg]) => arg.options.map((option) => option.label));
    expect(labels[0]).toEqual(["Release guide space-a", "list_releases"]);
    expect(labels[1]).toEqual(["Release guide space-b", "list_releases"]);
  });
});
