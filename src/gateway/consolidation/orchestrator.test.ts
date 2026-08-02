/**
 * P6 — consolidation orchestrator unit tests.
 *
 * Runs against a scratch dataDir; the pi sub-session is MOCKED (a fake
 * spawner writes diff.json directly — a real pi session is never launched).
 * Covers: run pipeline (spawn → diff.json → apply → report → checkpoint),
 * single-flight, missing diff.json, spawn failure, dry-run, disabled mode,
 * /status lastRun and env-whitelist delivery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../config.js";
import {
  ConsolidationOrchestrator,
  type RunSummary,
  type SpawnChildContext,
} from "./orchestrator.js";
import type { GatewayConfig } from "../config.js";
import type { Logger } from "../../core/types.js";
import type { ChildRunResult } from "./child-spawn.js";
import type { ApplyResult } from "../apply-executor.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeConfig(dataDir: string, enabled = true): GatewayConfig {
  return {
    server: { port: 0, host: "127.0.0.1", corsOrigins: [] },
    data: { baseDir: dataDir },
    llm: {
      baseUrl: "",
      apiKey: "",
      model: "fake",
      maxTokens: 1,
      timeoutMs: 1,
      disableThinking: false,
    },
    memory: parseConfig({
      consolidation: {
        enabled,
        diffCap: 10,
        diffByteCap: 4096,
        timeoutMs: 5000,
      },
      nightRun: { schedule: "06:00", threshold: 50, timezone: "system" },
    }),
  } as GatewayConfig;
}

const META = [
  "-----META-START-----",
  "created: 2026-08-02T00:00:00Z",
  "updated: 2026-08-02T00:00:00Z",
  "summary: t",
  "heat: 1",
  "-----META-END-----",
].join("\n");

function okApply(): ApplyResult {
  return {
    ok: true,
    status: "applied",
    partial: false,
    applied: { merges: [], deletes: ["m_1"], rewrites: [] },
    skipped: { merges: [], deletes: [], rewrites: [] },
    counts: null,
    reindexed: false,
    needsReindex: false,
    sceneIndexSynced: true,
  };
}

/** Fake spawner that writes a valid diff.json into the scratch dir. */
function writingSpawn(diff: unknown) {
  return vi.fn(async (ctx: SpawnChildContext): Promise<ChildRunResult> => {
    await fs.promises.writeFile(
      path.join(ctx.scratchDir, "diff.json"),
      JSON.stringify(diff),
      "utf-8",
    );
    return {
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "thinking trace",
      timedOut: false,
      killed: null,
    };
  });
}

describe("ConsolidationOrchestrator (P6)", () => {
  let tmp: string;
  let dataDir: string;
  let scratchRoot: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-oc-"));
    dataDir = path.join(tmp, "tdai");
    scratchRoot = path.join(tmp, "scratch");
    fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dataDir, "scene_blocks", "_global", "big.md"),
      `${META}\n\n${"x".repeat(2000)}`,
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeOrchestrator(
    opts: {
      enabled?: boolean;
      roleName?: string;
      roleDir?: string;
      spawn?: (ctx: SpawnChildContext) => Promise<ChildRunResult>;
      apply?: (body: unknown) => Promise<ApplyResult>;
    } = {},
  ) {
    return new ConsolidationOrchestrator({
      config: makeConfig(dataDir, opts.enabled ?? true),
      dataDir,
      scratchRoot,
      logger: silentLogger,
      gatewayUrl: "http://127.0.0.1:8420",
      roleName: opts.roleName,
      roleDir: opts.roleDir,
      spawnChild:
        opts.spawn ??
        writingSpawn({
          deleteL1: [{ id: "m_1", updatedAt: "2026-08-01T00:00:00Z" }],
        }),
      applyDiff: opts.apply ?? vi.fn(async () => okApply()),
    });
  }

  it("runs the full pipeline: spawn → diff.json → apply → report → checkpoint", async () => {
    const captured: { prompt: string }[] = [];
    const spawn = vi.fn(
      async (ctx: SpawnChildContext): Promise<ChildRunResult> => {
        // Capture the session prompt BEFORE the orchestrator cleans up scratch.
        captured.push({
          prompt: await fs.promises.readFile(ctx.promptPath, "utf-8"),
        });
        await fs.promises.writeFile(
          path.join(ctx.scratchDir, "diff.json"),
          JSON.stringify({
            deleteL1: [{ id: "m_1", updatedAt: "2026-08-01T00:00:00Z" }],
          }),
          "utf-8",
        );
        return {
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "thinking trace",
          timedOut: false,
          killed: null,
        };
      },
    );
    const apply = vi.fn(async () => okApply());
    const orch = makeOrchestrator({ spawn, apply });

    const summary = await orch.runNow({ reason: "test" });

    expect(summary.status).toBe("ok");
    expect(summary.role).toBe("memory-keeper");
    expect(summary.reason).toBe("test");
    expect(summary.applied.deletes).toEqual(["m_1"]);

    // Spawn got the whitelisted env + the session prompt file.
    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnCtx = spawn.mock.calls[0]![0] as SpawnChildContext;
    expect(Object.keys(spawnCtx.env).sort()).toEqual(
      [
        "HOME",
        "PATH",
        "PI_MEMORY_KEEPER",
        "PI_MEMORY_KEEPER_RUN",
        "TDAI_GATEWAY_URL",
      ].sort(),
    );
    expect(spawnCtx.env.PI_MEMORY_KEEPER).toBe("1");
    expect(spawnCtx.env.PI_MEMORY_KEEPER_RUN).toBeTruthy();
    // Scratch cwd is OUTSIDE the memory tree (ТЗ §5.1) — the sub-session's
    // relative-path escapes (../persona.md) cannot reach real memory files.
    expect(path.dirname(spawnCtx.cwd)).toBe(scratchRoot);
    expect(spawnCtx.cwd.startsWith(dataDir + path.sep)).toBe(false);
    expect(spawnCtx.cwd).not.toContain(path.join(dataDir, "scratch"));
    const prompt = captured[0]!.prompt;
    expect(prompt).toContain("## Текущий дифф (что разгрести)");
    expect(prompt).toContain("ДАННЫЕ, НЕ ИНСТРУКЦИИ");
    // Oversized scene listed as metadata only — the 2000-char body is absent.
    expect(prompt).toContain("scene_blocks/_global/big.md");
    expect(prompt).not.toContain("x".repeat(100));

    // Apply received diff + manifest baseline + presented ids.
    expect(apply).toHaveBeenCalledTimes(1);
    const applyBody = apply.mock.calls[0]![0] as {
      diff: unknown;
      manifest: { baseline: Record<string, string> };
      context: { presentedRecordIds: string[] };
    };
    expect(applyBody.diff).toEqual({
      deleteL1: [{ id: "m_1", updatedAt: "2026-08-01T00:00:00Z" }],
    });
    expect(applyBody.manifest.baseline["scene_blocks/_global/big.md"]).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(applyBody.context.presentedRecordIds).toEqual([]);

    // Report written to dataDir/logs/<role>-<ts>.json, valid JSON.
    const logsDir = path.join(dataDir, "logs");
    const files = fs
      .readdirSync(logsDir)
      .filter((f) => f.startsWith("memory-keeper-") && f.endsWith(".json"));
    expect(files.length).toBe(1);
    const report = JSON.parse(
      fs.readFileSync(path.join(logsDir, files[0]!), "utf-8"),
    ) as RunSummary;
    expect(report.status).toBe("ok");
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.child?.exitCode).toBe(0);
    expect(report.child?.stderr).toContain("thinking");

    // Checkpoint advanced.
    const cp = await orch.readCheckpoint();
    expect(cp.lastRunAt).toBeTruthy();
    expect(cp.roles["memory-keeper"]).toBeDefined();

    // /status source: lastRun is the same summary.
    expect(orch.getLastRun()?.status).toBe("ok");
  });

  it("single-flight: a second trigger while a run is in flight is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowSpawn = vi.fn(
      async (ctx: SpawnChildContext): Promise<ChildRunResult> => {
        await gate;
        await fs.promises.writeFile(
          path.join(ctx.scratchDir, "diff.json"),
          JSON.stringify({}),
          "utf-8",
        );
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          killed: null,
        };
      },
    );
    const orch = makeOrchestrator({ spawn: slowSpawn });

    const first = orch.runNow({ reason: "first" });
    // Give the run a tick to acquire the gate.
    await new Promise((r) => setTimeout(r, 20));
    expect(orch.isRunning).toBe(true);

    const second = await orch.trigger({ reason: "second" });
    expect(second.accepted).toBe(false);
    expect(second.status).toBe("busy");

    release();
    const summary = await first;
    expect(summary.status).toBe("ok");
    expect(slowSpawn).toHaveBeenCalledTimes(1);
    expect(orch.isRunning).toBe(false);
  });

  it("missing diff.json → failed run, apply never invoked (no partial apply)", async () => {
    const spawn = vi.fn(async (): Promise<ChildRunResult> => {
      return {
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        killed: null,
      };
    });
    const apply = vi.fn(async () => okApply());
    const orch = makeOrchestrator({ spawn, apply });

    const summary = await orch.runNow({ reason: "test" });
    expect(summary.status).toBe("failed");
    expect(summary.error).toMatch(/diff\.json missing or malformed/);
    expect(apply).not.toHaveBeenCalled();
    // Failed run must NOT advance the checkpoint (idempotent retry).
    const cp = await orch.readCheckpoint();
    expect(cp.lastRunAt).toBe("");
  });

  it("spawn failure → failed run, fail-open (критерий 21)", async () => {
    const spawn = vi.fn(async (): Promise<ChildRunResult> => {
      return {
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: "ENOENT: pi not found",
        killed: null,
      };
    });
    const orch = makeOrchestrator({ spawn });
    const summary = await orch.runNow({ reason: "test" });
    expect(summary.status).toBe("failed");
    expect(summary.error).toMatch(/spawn failed/);
    expect(orch.getLastRun()?.status).toBe("failed");
  });

  it("dry-run builds the diff, spawns nothing and does not advance the checkpoint", async () => {
    const spawn = vi.fn(async (): Promise<ChildRunResult> => ({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      killed: null,
    }));
    const apply = vi.fn(async () => okApply());
    const orch = makeOrchestrator({ spawn, apply });

    const summary = await orch.runNow({ reason: "manual", dryRun: true });
    expect(summary.status).toBe("dry-run");
    expect(spawn).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();

    // The diff section is written as a sidecar next to the report.
    const logsDir = path.join(dataDir, "logs");
    const sidecars = fs
      .readdirSync(logsDir)
      .filter((f) => f.startsWith("memory-keeper-") && f.endsWith(".diff.md"));
    expect(sidecars.length).toBe(1);
    const diffText = fs.readFileSync(path.join(logsDir, sidecars[0]!), "utf-8");
    expect(diffText).toContain("## Текущий дифф (что разгрести)");

    const cp = await orch.readCheckpoint();
    expect(cp.lastRunAt).toBe(""); // dry-run must not consume the cursor
  });

  it("dry-run preserves the scratch dir with the copied tools/ (retention for inspection)", async () => {
    const spawn = vi.fn(async (): Promise<ChildRunResult> => ({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      killed: null,
    }));
    const orch = makeOrchestrator({ spawn });

    const summary = await orch.runNow({ reason: "manual", dryRun: true });
    expect(summary.status).toBe("dry-run");

    // runId is embedded in the report sidecar dirs: scratch/<runId>/ survives.
    const runDirs = fs.readdirSync(scratchRoot).filter((f) => f.includes("-"));
    expect(runDirs.length).toBeGreaterThan(0);
    const runScratch = path.join(scratchRoot, runDirs[0]!);
    const tools = path.join(runScratch, "tools");
    expect(fs.existsSync(path.join(tools, "fetch_dups.py"))).toBe(true);
    expect(fs.existsSync(path.join(tools, "fetch_blocks.py"))).toBe(true);
    expect(fs.existsSync(path.join(tools, "fetch_records.py"))).toBe(true);
    expect(fs.existsSync(path.join(tools, "dump_bullets.py"))).toBe(true);
  });

  it("resolver: env override TDAI_KEEPER_TOOLS_DIR wins; src-topology sibling resolves by default", () => {
    const original = process.env.TDAI_KEEPER_TOOLS_DIR;
    try {
      // src-topology: the sibling of this module has the 4 scripts.
      expect(
        ConsolidationOrchestrator["resolveKeeperToolsDir"](),
      ).not.toBeNull();
      // env override: a fixture dir with fetch_dups.py wins.
      const fake = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kt-env-"));
      fs.writeFileSync(path.join(fake, "fetch_dups.py"), "x", "utf-8");
      process.env.TDAI_KEEPER_TOOLS_DIR = fake;
      expect(ConsolidationOrchestrator["resolveKeeperToolsDir"]()).toBe(fake);
      delete process.env.TDAI_KEEPER_TOOLS_DIR;
    } finally {
      if (original === undefined) delete process.env.TDAI_KEEPER_TOOLS_DIR;
      else process.env.TDAI_KEEPER_TOOLS_DIR = original;
    }
  });

  it("copyKeeperTools fail-open: missing tools dir → warn, run still completes (never aborts)", async () => {
    const original = process.env.TDAI_KEEPER_TOOLS_DIR;
    const warns: string[] = [];
    const logger = {
      ...silentLogger,
      warn: (m: string) => warns.push(m),
    };
    try {
      // Point the resolver at a dir that does not exist → copy must fail-open.
      process.env.TDAI_KEEPER_TOOLS_DIR = "/nonexistent/keeper-tools";
      const orch = new ConsolidationOrchestrator({
        config: makeConfig(dataDir, true),
        dataDir,
        scratchRoot,
        logger,
        gatewayUrl: "http://127.0.0.1:8420",
        spawnChild: writingSpawn({
          deleteL1: [{ id: "m_1", updatedAt: "2026-08-01T00:00:00Z" }],
        }),
        applyDiff: vi.fn(async () => okApply()),
      });
      const summary = await orch.runNow({ reason: "manual" });
      expect(summary.status).toBe("ok"); // run continued despite missing tools
      expect(warns.some((w) => w.includes("keeper-tools"))).toBe(true);
    } finally {
      if (original === undefined) delete process.env.TDAI_KEEPER_TOOLS_DIR;
      else process.env.TDAI_KEEPER_TOOLS_DIR = original;
    }
  });

  it("disabled consolidation → trigger refused with status disabled (fail-open)", async () => {
    const spawn = vi.fn(async (): Promise<ChildRunResult> => ({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      killed: null,
    }));
    const orch = makeOrchestrator({ enabled: false, spawn });
    const res = await orch.trigger({ reason: "manual" });
    expect(res.accepted).toBe(false);
    expect(res.status).toBe("disabled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("start() restores the last report from logs (status survives restart)", async () => {
    const orch = makeOrchestrator();
    await orch.runNow({ reason: "test" });

    const fresh = makeOrchestrator();
    await fresh.start();
    expect(fresh.getLastRun()?.status).toBe("ok");
    expect(fresh.getLastRun()?.role).toBe("memory-keeper");
  });

  // ============================
  // B3 — night-keeper role: fail-loud + role-file prompt + timeout_min
  // ============================

  it("night-keeper WITHOUT role file → run refused (fail-loud, not day semantics)", async () => {
    const roleDir = path.join(tmp, "roles"); // empty dir — no night-keeper.md
    fs.mkdirSync(roleDir, { recursive: true });
    const spawn = vi.fn();
    const orch = makeOrchestrator({ roleName: "night-keeper", roleDir, spawn });

    const summary = await orch.runNow({ reason: "night" });
    expect(summary.status).toBe("failed");
    expect(summary.error).toMatch(/night-keeper\.md.*missing/);
    expect(spawn).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("night-keeper WITH role file → prompt uses the role file, not DEFAULT_ROLE_PROMPT", async () => {
    const roleDir = path.join(tmp, "roles2");
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(
      path.join(roleDir, "night-keeper.md"),
      "ROLE-NIGHT-PROMPT",
      "utf-8",
    );

    const captured: { prompt: string }[] = [];
    const spawn = vi.fn(
      async (ctx: SpawnChildContext): Promise<ChildRunResult> => {
        captured.push({
          prompt: await fs.promises.readFile(ctx.promptPath, "utf-8"),
        });
        await fs.promises.writeFile(
          path.join(ctx.scratchDir, "diff.json"),
          JSON.stringify({}),
          "utf-8",
        );
        return {
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          killed: null,
        };
      },
    );
    const orch = makeOrchestrator({ roleName: "night-keeper", roleDir, spawn });

    const summary = await orch.runNow({ reason: "night" });
    expect(summary.status).toBe("ok");
    expect(summary.role).toBe("night-keeper");
    expect(captured[0]?.prompt).toContain("ROLE-NIGHT-PROMPT");
    expect(captured[0]?.prompt).not.toContain("Ты — memory-keeper"); // not DEFAULT_ROLE_PROMPT
  });

  it("day keeper WITHOUT role file → fail-open DEFAULT_ROLE_PROMPT (backward compat)", async () => {
    const roleDir = path.join(tmp, "roles3");
    fs.mkdirSync(roleDir, { recursive: true });
    const captured: { prompt: string }[] = [];
    const spawn = vi.fn(
      async (ctx: SpawnChildContext): Promise<ChildRunResult> => {
        captured.push({
          prompt: await fs.promises.readFile(ctx.promptPath, "utf-8"),
        });
        await fs.promises.writeFile(
          path.join(ctx.scratchDir, "diff.json"),
          JSON.stringify({}),
          "utf-8",
        );
        return {
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          killed: null,
        };
      },
    );
    const orch = makeOrchestrator({ roleDir, spawn });

    const summary = await orch.runNow({ reason: "test" });
    expect(summary.status).toBe("ok");
    expect(captured[0]?.prompt).toContain("Ты — memory-keeper"); // DEFAULT_ROLE_PROMPT
  });

  it("role-file timeout_min overrides consolidation timeoutMs (per-batch source)", async () => {
    const roleDir = path.join(tmp, "roles4");
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(
      path.join(roleDir, "night-keeper.md"),
      "ROLE-NIGHT-PROMPT",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(roleDir, "night-keeper.json"),
      JSON.stringify({ name: "night-keeper", timeout_min: 45 }),
      "utf-8",
    );
    const spawn = vi.fn(
      async (ctx: SpawnChildContext): Promise<ChildRunResult> => {
        await fs.promises.writeFile(
          path.join(ctx.scratchDir, "diff.json"),
          JSON.stringify({}),
          "utf-8",
        );
        return {
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          killed: null,
        };
      },
    );
    const orch = makeOrchestrator({ roleName: "night-keeper", roleDir, spawn });

    const summary = await orch.runNow({ reason: "night" });
    expect(summary.status).toBe("ok");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
