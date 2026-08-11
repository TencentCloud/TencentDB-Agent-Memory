/**
 * tz-09 Ф4a — critic bootstrap (criterion 6) and the verdict producer.
 *
 * Criterion 6 has four sub-cases, not one: no package, a role.json that does
 * not pass the schema, a host-incompatible binding, and a disabled critic.
 * Each must disable the MAIN role with its OWN reason, and only in enforce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCriticPackage } from "./critic-bootstrap.js";
import { launchCritic, CRITIC_VERDICT_FILE } from "./critic-launch.js";
import { resolveRoleContract } from "./role-contract.js";
import { createRun } from "../control-plane/run-repo.js";
import { listAttempts } from "../control-plane/attempt-repo.js";
import type { OrchestratorContext } from "./context.js";
import type { RoleLegacyDefaults } from "./role-contract-types.js";

const DEFAULTS: RoleLegacyDefaults = {
  timeoutMs: 60_000,
  night: {
    diffCap: 200,
    diffByteCap: 16_384,
    deletePerRun: 25,
    rewritePerRun: 25,
    scheduleRole: "night-keeper",
    thresholdRole: "memory-keeper",
  },
  day: {
    diffCap: 20,
    diffByteCap: 8_192,
    deletePerRun: 50,
    rewritePerRun: 50,
    threshold: 50,
  },
  failOpenPromptRoles: [],
  provider: "opencode-go",
  model: "deepseek-v4-flash",
  thinking: "low",
} as unknown as RoleLegacyDefaults;

function writeRole(
  roleDir: string,
  name: string,
  role: Record<string, unknown>,
  prompt: string | null = "critic prompt",
): void {
  const dir = path.join(roleDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "role.json"),
    JSON.stringify(role, null, 2),
    "utf-8",
  );
  if (prompt !== null) {
    fs.writeFileSync(path.join(dir, "prompt.md"), prompt, "utf-8");
  }
}

function fullRole(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    model: "opencode-go/deepseek-v4-flash",
    prompt_file: "prompt.md",
    enabled: true,
    thinking: "low",
    timeout_min: 10,
    scope: "fresh_tail",
    trigger: "manual_only",
    schedule: null,
    threshold: null,
    idsOnly: false,
    diff_cap: 20,
    diff_byte_cap: 8192,
    ops_subset: ["rewriteBlock"],
    tools_subset: [],
    caps: { delete_per_run: 10, rewrite_per_run: 10 },
    max_run_ms: 600000,
    fail_on_missing_prompt: false,
    critic_role: null,
    runtime: {},
    ...over,
  };
}

describe("critic bootstrap (tz-09 Ф4a, criterion 6)", () => {
  let dir: string;
  let roleDir: string;
  let ctx: OrchestratorContext;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-critic-"));
    roleDir = path.join(dir, "roles");
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    fs.mkdirSync(roleDir, { recursive: true });
    ctx = {
      dataDir: dir,
      roleDir,
      roleDefaults: DEFAULTS,
      applyGateMode: "enforce",
      gatewayUrl: "http://127.0.0.1:1",
      ownerPid: process.pid,
      now: () => Date.now(),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    } as unknown as OrchestratorContext;
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function mainRole(criticRole: string | null) {
    writeRole(
      roleDir,
      "keeper",
      fullRole("keeper", { critic_role: criticRole }),
    );
    const r = resolveRoleContract("keeper", roleDir, DEFAULTS);
    if (!r.ok) throw new Error(`fixture role did not resolve: ${r.reason}`);
    return r.contract;
  }

  it("no package at all → disabled with the reason", () => {
    const res = resolveCriticPackage(ctx, mainRole("memory-critic"));
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/memory-critic.*unusable/);
  });

  it("prompt-only directory (no role.json) is NOT a critic", () => {
    fs.mkdirSync(path.join(roleDir, "prompt-only"), { recursive: true });
    fs.writeFileSync(
      path.join(roleDir, "prompt-only", "prompt.md"),
      "just a prompt",
      "utf-8",
    );
    const res = resolveCriticPackage(ctx, mainRole("prompt-only"));
    expect(res.ok).toBe(false);
  });

  it("role.json that fails the schema → disabled, reason carries the failure", () => {
    writeRole(roleDir, "bad-critic", { name: "bad-critic", enabled: true });
    const res = resolveCriticPackage(ctx, mainRole("bad-critic"));
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(
      /bad-critic.*(unusable|no versioned package)/,
    );
  });

  it("a disabled critic is not a usable critic", () => {
    writeRole(
      roleDir,
      "off-critic",
      fullRole("off-critic", { enabled: false }),
    );
    const res = resolveCriticPackage(ctx, mainRole("off-critic"));
    expect(res.ok).toBe(false);
  });

  it("no critic_role declared → reason says so", () => {
    const res = resolveCriticPackage(ctx, mainRole(null));
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/declares no critic_role/);
  });

  it("a full package resolves", () => {
    writeRole(roleDir, "good-critic", fullRole("good-critic"));
    const res = resolveCriticPackage(ctx, mainRole("good-critic"));
    expect(res.ok).toBe(true);
  });
});

describe("critic launch — the verdict producer (tz-09 Ф4a)", () => {
  let dir: string;
  let roleDir: string;
  let scratch: string;
  let ctx: OrchestratorContext;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cl-"));
    roleDir = path.join(dir, "roles");
    scratch = path.join(dir, "scratch");
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    fs.mkdirSync(roleDir, { recursive: true });
    fs.mkdirSync(scratch, { recursive: true });
    createRun(
      dir,
      {
        runId: "r1",
        roleId: "keeper",
        contractHash: "h",
        contractJson: "{}",
        binding: "{}",
      },
      new Date().toISOString(),
    );
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function criticContract() {
    writeRole(roleDir, "good-critic", fullRole("good-critic"));
    const r = resolveRoleContract("good-critic", roleDir, DEFAULTS);
    if (!r.ok) throw new Error("critic fixture did not resolve");
    return r.contract;
  }

  function ctxWith(
    spawn: OrchestratorContext["spawnChild"],
  ): OrchestratorContext {
    return {
      dataDir: dir,
      roleDir,
      roleDefaults: DEFAULTS,
      applyGateMode: "enforce",
      gatewayUrl: "http://127.0.0.1:1",
      ownerPid: process.pid,
      now: () => Date.now(),
      spawnChild: spawn,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    } as unknown as OrchestratorContext;
  }

  it("spawns the critic into the SAME scratch and returns its verdict", async () => {
    const spawn = vi.fn(async () => {
      fs.writeFileSync(
        path.join(scratch, CRITIC_VERDICT_FILE),
        JSON.stringify({ verdict: "approve", candidateDigest: "abc" }),
        "utf-8",
      );
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
    });
    ctx = ctxWith(spawn as never);

    const res = await launchCritic(ctx, {
      runId: "r1",
      scratchDir: scratch,
      critic: criticContract(),
      candidateDigest: "abc",
    });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.verdictText ?? "{}").verdict).toBe("approve");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0].cwd).toBe(scratch);
    expect(listAttempts(dir, "r1").map((a) => a.kind)).toEqual(["critic"]);
  });

  it("an approve from a critic that EXITED NON-ZERO is refused", async () => {
    // The apply gate hangs on this verdict, so "the file says approve" is not
    // enough — the process that wrote it has to have succeeded (L7).
    const spawn = vi.fn(async () => {
      fs.writeFileSync(
        path.join(scratch, CRITIC_VERDICT_FILE),
        JSON.stringify({ verdict: "approve", candidateDigest: "abc" }),
        "utf-8",
      );
      return { exitCode: 1, timedOut: false, stdout: "", stderr: "boom" };
    });
    ctx = ctxWith(spawn as never);

    const res = await launchCritic(ctx, {
      runId: "r1",
      scratchDir: scratch,
      critic: criticContract(),
      candidateDigest: "abc",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("critic exited code 1");
    expect(listAttempts(dir, "r1")[0]?.outcome).toBe("failed");
  });

  it("a verdict left by a PREVIOUS attempt is never reused", async () => {
    fs.mkdirSync(path.dirname(path.join(scratch, CRITIC_VERDICT_FILE)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(scratch, CRITIC_VERDICT_FILE),
      JSON.stringify({ verdict: "approve", candidateDigest: "stale" }),
      "utf-8",
    );
    ctx = ctxWith((async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
    })) as never);

    const res = await launchCritic(ctx, {
      runId: "r1",
      scratchDir: scratch,
      critic: criticContract(),
      candidateDigest: "abc",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/produced no out\/critic\.json/);
  });

  it("a timed-out critic yields no verdict and records the outcome", async () => {
    ctx = ctxWith((async () => ({
      exitCode: null,
      timedOut: true,
      stdout: "",
      stderr: "",
    })) as never);
    const res = await launchCritic(ctx, {
      runId: "r1",
      scratchDir: scratch,
      critic: criticContract(),
      candidateDigest: "abc",
    });
    expect(res.ok).toBe(false);
    expect(listAttempts(dir, "r1")[0]?.outcome).toBe("timeout");
  });
});
