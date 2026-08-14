import { describe, expect, it } from "vitest";
import { createPiLauncher } from "./pi.js";
import type { ResolvedRoleContract } from "../role-contract-types.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("pi stdout-only role policy", () => {
  it("owns every ambient-discovery flag", async () => {
    let argv: string[] = [];
    const launcher = createPiLauncher(
      {
        binary: "/bin/echo",
        flags: [
          "-p",
          "-e",
          "/host/ext",
          "--tools=read",
          "--skill=/host/skill",
          "--append-system-prompt",
          "/host/prompt",
        ],
      },
      logger,
    );
    const contract = {
      binding: {
        model: "model",
        thinking: "low",
        isolationProfileRef: null,
      },
      assets: {
        extensionPath: null,
        skillPath: null,
        ambientAccess: "none",
      },
      timeoutMs: 1_000,
    } as ResolvedRoleContract;
    const result = await launcher.launch({
      runId: "run",
      attemptId: "attempt",
      cwd: "/tmp",
      promptPath: "/tmp/prompt",
      taskPrompt: "task",
      env: {},
      contract,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = await result.handle.completion;
    argv = outcome.stdout.split(/\s+/);
    expect(argv).toEqual(
      expect.arrayContaining([
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-approve",
      ]),
    );
    expect(argv).not.toContain("/host/ext");
    expect(argv).not.toContain("read");
    expect(argv).not.toContain("/host/skill");
    expect(argv).not.toContain("/host/prompt");
  });

  it("rejects explicit role assets under ambient-none", async () => {
    const launcher = createPiLauncher({ binary: "/bin/echo" }, logger);
    const contract = {
      binding: { model: "model", thinking: "low", isolationProfileRef: null },
      assets: {
        extensionPath: "/host/extension.ts",
        skillPath: null,
        ambientAccess: "none",
      },
      timeoutMs: 1_000,
    } as ResolvedRoleContract;
    const result = await launcher.launch({
      runId: "run",
      attemptId: "attempt",
      cwd: "/tmp",
      promptPath: "/tmp/prompt",
      taskPrompt: "task",
      env: {},
      contract,
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid-binding" } });
  });
});
