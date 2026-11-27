import { describe, expect, it } from "vitest";
import { HookRegistryImpl } from "../../../registry.js";
import { OpenAIAdapter } from "../../../adapters/openai.js";
import { InjectionPipeline } from "../../../pipeline.js";
import { PiProfile } from "../profile.js";
import { HOOK_PRIORITY } from "../../../types.js";
import type { AgentContext, ContextBlock, InjectionHook } from "../../../types.js";

/**
 * End-to-end regression: drives the real InjectionPipeline with the Pi profile
 * registered the way the proxy registers it at runtime, and asserts the memory
 * block reaches the final system prompt exactly once.
 *
 * The prompt below mirrors the shape Pi actually emits: <project_context>
 * nests <project_instructions path="...">, and that block's body is an
 * AGENTS.md containing label-shaped lines of its own.
 */
const PI_SYSTEM = [
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
  "",
  "Available tools:",
  "- read",
  "- edit",
  "",
  "Guidelines:",
  "- Be concise in your responses",
  "- Show file paths clearly when working with files",
  "",
  "<project_context>",
  "",
  "Project-specific instructions and guidelines:",
  "",
  '<project_instructions path="/repo/AGENTS.md">',
  "# Repo rules",
  "",
  "Guidelines:",
  "- Follow existing patterns in the codebase.",
  "- Never commit secrets.",
  "",
  "Ownership rules:",
  "- One writer per file.",
  "</project_instructions>",
  "",
  "</project_context>",
  "",
  "Current working directory: /repo",
].join("\n");

const MARKER = "TDAI_MEMORY_BLOCK_MARKER";
const NESTED_START = '<project_instructions path="/repo/AGENTS.md">';

/** Mirrors SkillInjector: anchors on the "skills" slot (→ "Guidelines" key). */
class MarkerInjector implements InjectionHook {
  id = "test-marker-injector";
  point = "system.before_tools" as const;
  anchor = { slot: "skills", relation: "before" } as const;
  priority = HOOK_PRIORITY.SKILL;
  description = "Test double for a memory/skills injector.";
  execute(_ctx: AgentContext): ContextBlock[] {
    return [{ type: "text", content: MARKER }];
  }
}

async function runPipeline(): Promise<string> {
  const registry = new HookRegistryImpl();
  registry.register(new MarkerInjector());
  const pipeline = new InjectionPipeline(
    registry,
    new Map([["openai", new OpenAIAdapter()]]),
    { agentProfiles: new Map([["pi", new PiProfile()]]) },
  );

  const body = {
    model: "glm-5.2-vision",
    messages: [
      { role: "system", content: PI_SYSTEM },
      { role: "user", content: "hello" },
    ],
  };

  const out = (await pipeline.process(body as Record<string, unknown>, {
    protocol: "openai",
    agentSource: "pi",
    stream: false,
  } as never)) as { messages: Array<{ role: string; content: unknown }> };

  const sys = out.messages.find((m) => m.role === "system");
  return typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content);
}

describe("PiProfile through the real InjectionPipeline", () => {
  it("injects the anchored block exactly once", async () => {
    const sysText = await runPipeline();

    expect(sysText.split(MARKER)).toHaveLength(2);
  });

  it("lands every injected block on the top-level section, never inside project instructions", async () => {
    const sysText = await runPipeline();
    const nestedAt = sysText.indexOf(NESTED_START);
    const markerPositions = [...sysText.matchAll(new RegExp(MARKER, "g"))].map(
      (m) => m.index!,
    );

    expect(markerPositions.length).toBeGreaterThan(0);
    expect(nestedAt).toBeGreaterThan(-1);
    // No copy may fall inside the nested block — that is the misplaced duplicate.
    for (const pos of markerPositions) {
      expect(pos).toBeLessThan(nestedAt);
    }
  });

  it("keeps the enclosing project_context block intact", () => {
    // Segment-level assertion: the nested instructions must stay inside the
    // project_context section rather than being cut at the nested label.
    const projectContext = new PiProfile()
      .parse(PI_SYSTEM)
      .find((s) => s.key === "project_context");

    expect(projectContext?.rawText).toContain(NESTED_START);
    expect(projectContext?.rawText).toContain("- Never commit secrets.");
    expect(projectContext?.rawText).toContain("</project_instructions>");
  });

  it("leaves the non-system messages untouched", async () => {
    const registry = new HookRegistryImpl();
    registry.register(new MarkerInjector());
    const pipeline = new InjectionPipeline(
      registry,
      new Map([["openai", new OpenAIAdapter()]]),
      { agentProfiles: new Map([["pi", new PiProfile()]]) },
    );

    const out = (await pipeline.process(
      {
        model: "glm-5.2-vision",
        messages: [
          { role: "system", content: PI_SYSTEM },
          { role: "user", content: "hello" },
        ],
      } as Record<string, unknown>,
      { protocol: "openai", agentSource: "pi", stream: false } as never,
    )) as { messages: Array<{ role: string; content: unknown }> };

    expect(out.messages.find((m) => m.role === "user")?.content).toBe("hello");
  });
});
