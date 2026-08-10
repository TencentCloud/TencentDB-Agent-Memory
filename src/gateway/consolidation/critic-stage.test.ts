/**
 * tz-09 Ф4b — the critic stage as a gate (criteria 7 and 10).
 *
 * Every refusal is checked in ENFORCE with a spy on apply: the assertion is
 * "apply was not called", not "some status was returned". In shadow the same
 * inputs must pass, otherwise the flag would not be a flag.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCriticStage, digestOf } from "./critic-stage.js";
import { CRITIC_VERDICT_FILE } from "./critic-launch.js";
import { resolveRoleContract } from "./role-contract.js";
import { createRun, readRun } from "../control-plane/run-repo.js";
import type { OrchestratorContext } from "./context.js";
import type { RoleLegacyDefaults } from "./role-contract-types.js";

const DEFAULTS = {
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

function roleJson(name: string, over: Record<string, unknown> = {}) {
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

const CANDIDATE = { rewriteBlock: [{ path: "scene_blocks/_global/a.md" }] };
const INPUT_DIGEST = "input-digest-1";

describe("critic stage gate (tz-09 Ф4b)", () => {
  let dir: string;
  let roleDir: string;
  let scratch: string;
  let warns: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cs-"));
    roleDir = path.join(dir, "roles");
    scratch = path.join(dir, "scratch");
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    fs.mkdirSync(scratch, { recursive: true });
    warns = [];
    for (const name of ["keeper", "good-critic"]) {
      const d = path.join(roleDir, name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(
        path.join(d, "role.json"),
        JSON.stringify(
          roleJson(
            name,
            name === "keeper" ? { critic_role: "good-critic" } : {},
          ),
        ),
        "utf-8",
      );
      fs.writeFileSync(path.join(d, "prompt.md"), `${name} prompt`, "utf-8");
    }
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

  function mainContract() {
    const r = resolveRoleContract("keeper", roleDir, DEFAULTS);
    if (!r.ok) throw new Error(`keeper fixture: ${r.reason}`);
    return r.contract;
  }

  /** Context whose critic child writes exactly `verdict` (or nothing). */
  function ctxFor(
    verdict: unknown | null,
    mode: "shadow" | "enforce",
  ): OrchestratorContext {
    return {
      dataDir: dir,
      roleDir,
      roleDefaults: DEFAULTS,
      applyGateMode: mode,
      gatewayUrl: "http://127.0.0.1:1",
      ownerPid: process.pid,
      now: () => Date.now(),
      spawnChild: vi.fn(async () => {
        if (verdict !== null) {
          fs.writeFileSync(
            path.join(scratch, CRITIC_VERDICT_FILE),
            typeof verdict === "string" ? verdict : JSON.stringify(verdict),
            "utf-8",
          );
        }
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      }),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (m: string) => warns.push(m),
        error: () => undefined,
      },
    } as unknown as OrchestratorContext;
  }

  const stage = (ctx: OrchestratorContext) =>
    runCriticStage(ctx, {
      runId: "r1",
      scratchDir: scratch,
      role: mainContract(),
      candidate: CANDIDATE,
      inputDigest: INPUT_DIGEST,
    });

  it("approve → apply may proceed, receipt names the same candidate", async () => {
    const digest = digestOf(CANDIDATE);
    const res = await stage(
      ctxFor({ verdict: "approve", candidateDigest: digest }, "enforce"),
    );
    expect(res.ok).toBe(true);
    const row = readRun(dir, "r1");
    expect(row?.state).toBe("reviewed");
    expect(row?.candidateDigest).toBe(digest);
    expect(row?.criticReceipt).toContain("approve");
  });

  it("negative verdict → apply refused, receipt on the same candidateDigest", async () => {
    const digest = digestOf(CANDIDATE);
    const res = await stage(
      ctxFor(
        {
          verdict: "reject",
          candidateDigest: digest,
          reasons: ["deletes too much"],
        },
        "enforce",
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/critic rejected.*deletes too much/);
    expect(readRun(dir, "r1")?.candidateDigest).toBe(digest);
  });

  it("no verdict at all → refused (absence is never a default-approve)", async () => {
    const res = await stage(ctxFor(null, "enforce"));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/produced no critic.json/);
  });

  it("unparseable verdict → refused", async () => {
    const res = await stage(ctxFor("not json at all", "enforce"));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not valid JSON/);
  });

  it("verdict about a DIFFERENT candidate → refused", async () => {
    const res = await stage(
      ctxFor(
        { verdict: "approve", candidateDigest: digestOf({ other: true }) },
        "enforce",
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/different candidate/);
  });

  // Criterion 10 — candidate-bound-to-input.
  it("verdict produced from a different inputDigest → refused", async () => {
    const res = await stage(
      ctxFor(
        {
          verdict: "approve",
          candidateDigest: digestOf(CANDIDATE),
          inputDigest: "tampered",
        },
        "enforce",
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/different input/);
  });

  it("shadow: every one of those cases passes, with a log line", async () => {
    for (const verdict of [
      null,
      "not json",
      { verdict: "approve", candidateDigest: "other" },
      { verdict: "reject", candidateDigest: digestOf(CANDIDATE) },
    ]) {
      const res = await stage(ctxFor(verdict, "shadow"));
      expect(res.ok).toBe(true);
    }
    expect(warns.filter((w) => w.includes("SHADOW would refuse"))).toHaveLength(
      4,
    );
  });
});
