import { describe, expect, it } from "vitest";
import path from "node:path";
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

  /**
   * The child's HOME is a fresh per-attempt dir, so the operator's subagent
   * definitions are invisible unless the launcher names them. Measured on the
   * child's REAL environment: `/bin/sh -c env` prints it and ignores the
   * trailing arguments piArgs appends. The `/bin/echo` cases above read argv
   * and cannot see env at all.
   */
  async function childEnv(
    ambientAccess: "inherit" | "none",
    subagentDirs?: string[],
  ): Promise<string[]> {
    const launcher = createPiLauncher(
      { binary: "/bin/sh", flags: ["-c", "env"], subagentDirs },
      logger,
    );
    const result = await launcher.launch({
      runId: "run",
      attemptId: `attempt-${ambientAccess}`,
      cwd: "/tmp",
      promptPath: "/tmp/prompt",
      taskPrompt: "task",
      env: {},
      contract: {
        binding: { model: "model", thinking: "low", isolationProfileRef: null },
        assets: { extensionPath: null, skillPath: null, ambientAccess },
        timeoutMs: 1_000,
      } as ResolvedRoleContract,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return [];
    return (await result.handle.completion).stdout.split("\n");
  }

  it("hands the subagent dirs to an ordinary role, joined as a path list", async () => {
    const env = await childEnv("inherit", ["/host/agents", "/other/agents"]);
    expect(env).toContain(
      `PI_SUBAGENT_EXTRA_AGENT_DIRS=/host/agents${path.delimiter}/other/agents`,
    );
  });

  it("withholds them from an ambient-none role", async () => {
    const env = await childEnv("none", ["/host/agents"]);
    expect(
      env.filter((line) => line.startsWith("PI_SUBAGENT_EXTRA_AGENT_DIRS")),
    ).toEqual([]);
  });

  it("sets nothing when no dirs are configured", async () => {
    const env = await childEnv("inherit");
    expect(
      env.filter((line) => line.startsWith("PI_SUBAGENT_EXTRA_AGENT_DIRS")),
    ).toEqual([]);
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
