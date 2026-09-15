import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersonaGenerator } from "./persona-generator.js";
import type { LLMRunParams, LLMRunner } from "../types.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("PersonaGenerator", () => {
  it("lets an injected LLM runner use its configured timeout", async () => {
    const dataDir = await makeTempDir("persona-generator-");
    const calls: LLMRunParams[] = [];
    const runner: LLMRunner = {
      async run(params) {
        calls.push(params);
        await fs.writeFile(path.join(params.workspaceDir!, "persona.md"), "Prefers concise technical answers.", "utf-8");
        return "";
      },
    };

    const generator = new PersonaGenerator({
      dataDir,
      config: {},
      llmRunner: runner,
    });

    const result = await generator.generateLocalPersona("test");

    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].timeoutMs).toBeUndefined();
  });
});
