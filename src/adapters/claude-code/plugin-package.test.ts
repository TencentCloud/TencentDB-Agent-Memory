import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface HookDefinition {
  hooks: Array<{
    command: string;
    args?: string[];
  }>;
}

describe("Claude Code plugin package", () => {
  it("keeps every lifecycle command inside the cached plugin directory", async () => {
    const pluginRoot = path.resolve("claude-code-plugin");
    const hooks = JSON.parse(
      await fs.readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
    ) as { hooks: Record<string, HookDefinition[]> };

    expect(Object.keys(hooks.hooks)).toEqual([
      "UserPromptSubmit",
      "Stop",
      "SessionEnd",
    ]);
    for (const definitions of Object.values(hooks.hooks)) {
      for (const definition of definitions) {
        for (const hook of definition.hooks) {
          expect(hook.command).toBe("node");
          expect(hook.args).toEqual([
            "${CLAUDE_PLUGIN_ROOT}/scripts/memory-hook.mjs",
          ]);
          expect(hook.args?.[0]).not.toContain("../");
        }
      }
    }

    await expect(fs.access(path.join(pluginRoot, "scripts", "memory-hook.mjs")))
      .resolves.toBeUndefined();
  });

  it("declares the manifest at Claude Code's standard plugin path", async () => {
    const manifest = JSON.parse(await fs.readFile(
      path.resolve("claude-code-plugin", ".claude-plugin", "plugin.json"),
      "utf8",
    )) as { name?: string; version?: string };

    expect(manifest.name).toBe("tencentdb-agent-memory");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
