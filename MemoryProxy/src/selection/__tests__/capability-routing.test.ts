import { describe, expect, it, vi } from "vitest";
import { DecisionProviderError, type DecisionProvider } from "../../decision/types.js";
import { ChoiceSelectionStrategy } from "../strategies/choice.js";
import type { SelectionInput, SelectionOutcome, SelectionStrategy } from "../types.js";
import {
  buildCapabilitySnapshot as rankCapabilities,
  describeRequestTools,
  observeCapabilityChoice,
} from "../capability-routing.js";
import type { CapabilityProtocol } from "../capability-routing.js";

function buildCapabilitySnapshot(input: Omit<Parameters<typeof rankCapabilities>[0], "tools"> & {
  protocol: CapabilityProtocol;
  tools: unknown;
}) {
  const { protocol, tools, ...rest } = input;
  return rankCapabilities({ ...rest, tools: describeRequestTools(tools, protocol) });
}

function tool(name: string, description: string, parameters = { type: "object" }) {
  return { type: "function", function: { name, description, parameters } };
}

function testStrategy(choose: (input: SelectionInput) => SelectionOutcome) {
  const select = vi.fn(async (input: SelectionInput) => choose(input));
  const strategy: SelectionStrategy = { name: "fixture", model: "", isUsable: () => true, select };
  return { strategy, select };
}

const limit = { topK: 2, secondPassTopK: 5, criteriaCharBudget: 8000 };

describe("capability snapshot", () => {
  it("ranks current tool descriptions and scoped Core skills and keeps memory available", () => {
    const snapshot = buildCapabilitySnapshot({
      protocol: "openai", query: "Find the release notes", includeMemory: true,
      tools: [tool("lookup_weather", "Get weather"), tool("find_release", "Find release notes")],
      skills: [{ skill_id: "skill-1", version: 3, name: "Release review", description: "Review release notes" }],
    });
    expect(snapshot.candidates.map((entry) => entry.id)).toEqual([
      "memory.search", "skill:skill-1", "tool:find_release", "tool:lookup_weather",
    ]);
    expect(snapshot.candidates.find((entry) => entry.id === "skill:skill-1")?.sourceVersion).toBe("3");
    expect(Object.isFrozen(snapshot.candidates[0])).toBe(true);
    expect(Object.isFrozen(snapshot.candidates)).toBe(true);
  });

  it("rejects ambiguous IDs, malformed tool schemas and oversized descriptors", () => {
    const snapshot = buildCapabilitySnapshot({
      protocol: "anthropic", query: "Check the release", includeMemory: false, skills: [],
      tools: [
        { name: "same", description: "first", input_schema: { type: "object" } },
        { name: "same", description: "second", input_schema: { type: "object" } },
        { name: "oversize", description: "x".repeat(1100), input_schema: { type: "object" } },
        { name: "no_schema", description: "Invalid function" },
        { name: "web_search", type: "web_search_20250305", description: "server tool" },
        { name: "check_release", description: "Check release", input_schema: { type: "object" } },
      ],
    });
    expect(snapshot.candidates.map((entry) => entry.id)).toEqual(["tool:check_release"]);
  });

  it("fingerprints changed tool schemas and skill versions", () => {
    const args = {
      protocol: "openai" as const, query: "check", includeMemory: false,
      skills: [{ skill_id: "skill-1", version: 3, name: "Check", description: "" }],
      tools: [tool("check", "check")],
    };
    const original = buildCapabilitySnapshot(args).fingerprint;
    expect(buildCapabilitySnapshot(args).fingerprint).toBe(original);
    expect(buildCapabilitySnapshot({ ...args, skills: [{ ...args.skills[0]!, version: 4 }] }).fingerprint).not.toBe(original);
    expect(buildCapabilitySnapshot({ ...args, tools: [tool("check", "check", { type: "array" })] }).fingerprint).not.toBe(original);
  });

  it("keeps a relevant tool in the first pass even behind 120 other declarations", () => {
    const tools = Array.from({ length: 120 }, (_, index) => tool(`weather_${index}`, "Forecast temperature"));
    tools.push(tool("search_release", "Find release notes by version"));
    const snapshot = buildCapabilitySnapshot({
      protocol: "openai", query: "Read release notes", tools, skills: [], includeMemory: true,
    });
    expect(snapshot.candidates).toHaveLength(122);
    expect(snapshot.candidates.slice(0, 12).map((entry) => entry.id)).toContain("tool:search_release");
  });
});

describe("shadow choice", () => {
  const snapshot = buildCapabilitySnapshot({
    protocol: "openai", query: "Check release", includeMemory: false, skills: [],
    tools: [
      tool("check_release", "Check release"),
      tool("list_release", "List release"),
      tool("read_changelog", "Read recent changes"),
    ],
  });

  it("runs one wider pass only when the strategy asks and validates against that pass", async () => {
    let attempts = 0;
    const { strategy, select } = testStrategy((input) => {
      const label = attempts++ === 0 ? "Search more candidates" : "read_changelog";
      return { kind: "selected", optionId: input.options.find((option) => option.label === label)!.id };
    });
    const result = await observeCapabilityChoice(snapshot, "user: Check release", limit, strategy);
    expect(result).toMatchObject({ kind: "tool", passes: 2, reason: "selected" });
    expect(select.mock.calls.map(([input]) => input.options.map((option) => option.label))).toEqual([
      ["check_release", "list_release", "Search more candidates"],
      ["check_release", "list_release", "read_changelog"],
    ]);
  });

  it.each([
    [{ kind: "selected", optionId: "tool:invented" }, "invalid_choice"],
    [{ kind: "unavailable", reason: "fixture_timeout" }, "strategy_unavailable"],
    [{ kind: "none", reason: "low_confidence" }, "low_confidence"],
  ] as const)("falls back to direct for %j", async (outcome, reason) => {
    const { strategy, select } = testStrategy(() => outcome);
    expect(await observeCapabilityChoice(snapshot, "user: Check release", limit, strategy))
      .toMatchObject({ kind: "direct", passes: 1, reason });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does not send raw tool parameters or exceed the criteria budget", async () => {
    const secret = "fixture-argument-that-must-stay-local";
    const containingSchema = buildCapabilitySnapshot({
      protocol: "openai", query: "Check", skills: [], includeMemory: false,
      tools: [tool("check_release", "A".repeat(360), { type: secret })],
    });
    const { strategy, select } = testStrategy(() => ({ kind: "none" }));
    await observeCapabilityChoice(containingSchema, "user: Check", { ...limit, criteriaCharBudget: 160 }, strategy);
    const input = select.mock.calls[0]?.[0];
    expect(input).toBeDefined();
    expect(JSON.stringify(input)).not.toContain(secret);
    expect(input!.options.reduce((sum, option) => sum + option.label.length + (option.description?.length ?? 0), 0))
      .toBeLessThanOrEqual(160);
  });

  it("logs the provider failure category without logging the response body", async () => {
    const provider: DecisionProvider = {
      name: "fixture", model: "fixture", maxChoiceOptions: 100, isUsable: () => true,
      askChoices: async () => { throw new DecisionProviderError("http_error", "private fixture response"); },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const strategy = new ChoiceSelectionStrategy(provider);
      const outcome = await observeCapabilityChoice(snapshot, "user: Check release", limit, strategy);
      expect(outcome).toMatchObject({ kind: "direct", reason: "strategy_unavailable" });
      expect(warn).toHaveBeenCalledWith("[selection:fixture] call failed: http_error");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private fixture response");
    } finally {
      warn.mockRestore();
    }
  });
});
