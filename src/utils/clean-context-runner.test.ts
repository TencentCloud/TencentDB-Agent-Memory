import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CleanContextRunner, type EmbeddedAgentRuntimeLike } from "./clean-context-runner.js";

async function removeDefaultCleanWorkspace(): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const fallbackRoot = path.join(os.tmpdir(), uid === undefined ? "openclaw" : `openclaw-${uid}`);
  await Promise.all([
    fs.rm(path.join("/tmp/openclaw", "memory-tdai-clean-workspace"), { recursive: true, force: true }),
    fs.rm(path.join(fallbackRoot, "memory-tdai-clean-workspace"), { recursive: true, force: true }),
  ]);
}

describe("CleanContextRunner", () => {
  it("seeds the default clean workspace with task brief files before running the embedded agent", async () => {
    await removeDefaultCleanWorkspace();

    const calls: Array<Record<string, unknown>> = [];
    const runEmbeddedPiAgent: NonNullable<EmbeddedAgentRuntimeLike["runEmbeddedPiAgent"]> =
      (async (args: Record<string, unknown>) => {
        calls.push(args);
        return { payloads: [{ text: "[]" }] };
      }) as NonNullable<EmbeddedAgentRuntimeLike["runEmbeddedPiAgent"]>;

    const runner = new CleanContextRunner({
      config: {
        agents: {
          defaults: {
            systemPromptOverride: "host prompt that should be replaced",
          },
        },
      },
      agentRuntime: { runEmbeddedPiAgent },
      enableTools: false,
    });

    const result = await runner.run({
      prompt: "conversation payload",
      systemPrompt: "extract memories as JSON",
      taskId: "l1-extraction",
      timeoutMs: 1_000,
    });

    expect(result).toBe("[]");
    expect(calls).toHaveLength(1);

    const call = calls[0];
    expect(call.prompt).toBe("conversation payload");
    expect(call.extraSystemPrompt).toBe("extract memories as JSON");
    expect(call.disableTools).toBe(true);
    expect((call.config as { agents: { defaults: { systemPromptOverride: string } } }).agents.defaults.systemPromptOverride)
      .toBe("extract memories as JSON");

    const workspaceDir = call.workspaceDir;
    expect(typeof workspaceDir).toBe("string");

    const agents = await fs.readFile(path.join(workspaceDir as string, "AGENTS.md"), "utf8");
    const soul = await fs.readFile(path.join(workspaceDir as string, "SOUL.md"), "utf8");

    expect(agents.length).toBeGreaterThan(76);
    expect(agents).toContain("TencentDB Agent Memory");
    expect(agents).toContain("explicit system prompt and user prompt");
    expect(soul.length).toBeGreaterThan(76);
    expect(soul).toContain("system and user prompts");
  });
});
