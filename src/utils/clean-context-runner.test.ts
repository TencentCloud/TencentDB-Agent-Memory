import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CleanContextRunner } from "./clean-context-runner.js";

describe("CleanContextRunner", () => {
  it("seeds default clean workspace with task brief files and passes explicit prompts", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runner = new CleanContextRunner({
      config: {
        agents: {
          defaults: {
            systemPromptOverride: "existing host prompt",
          },
        },
      },
      agentRuntime: {
        runEmbeddedPiAgent: (async (args: Record<string, unknown>) => {
          calls.push(args);
          return {
            payloads: [
              {
                text: "[]",
              },
            ],
          };
        }) as never,
      },
    });

    const result = await runner.run({
      taskId: "l1-extraction",
      systemPrompt: "extract memories as JSON",
      prompt: "conversation payload",
      timeoutMs: 1000,
    });

    expect(result).toBe("[]");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.prompt).toBe("conversation payload");
    expect(call.extraSystemPrompt).toBe("extract memories as JSON");
    expect(call.disableTools).toBe(true);
    expect((call.config as {
      agents: { defaults: { systemPromptOverride: string } };
    }).agents.defaults.systemPromptOverride).toBe("extract memories as JSON");

    const workspaceDir = call.workspaceDir;
    expect(typeof workspaceDir).toBe("string");
    const agents = await fs.readFile(path.join(workspaceDir as string, "AGENTS.md"), "utf8");
    const soul = await fs.readFile(path.join(workspaceDir as string, "SOUL.md"), "utf8");

    expect(agents.length).toBeGreaterThan(76);
    expect(agents).toContain("TencentDB Agent Memory");
    expect(agents).toContain("Follow the explicit system prompt and user prompt");
    expect(soul.length).toBeGreaterThan(76);
    expect(soul).toContain("system and user prompts");
  });
});
