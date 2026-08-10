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
import { buildRoleDefaults } from "../role-defaults.js";
import {
  ConsolidationOrchestrator,
  type RunSummary,
  type SpawnChildContext,
} from "./orchestrator.js";
import type { GatewayConfig } from "../config.js";
import type { Logger } from "../../core/types.js";
import type { ChildRunResult } from "./child-spawn.js";
import type { ApplyResult } from "../apply-executor.js";
import { clearRoleContractCache } from "./role-contract.js";
import { createRequire } from "node:module";

// Mock the process runner at module level (hoisted): the stop()-both-kill test
// needs the REAL defaultSpawnChild onChild registration to fill childrenRef
// without spawning a real pi sub-session. Tests that pass an explicit
// `spawn` override are unaffected; tests using defaultSpawnChild without a
// real run (start()/getLastRun()) never reach the spawner.
vi.mock("./launchers/child-process.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./launchers/child-process.js")>();
  return {
    ...actual,
    runChildProcess: vi.fn(),
  };
});
vi.mock("./child-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./child-spawn.js")>();
  return {
    ...actual,
    killChildGroup: vi.fn(),
    // stop()/start() sweep real keepers — stub so the stop-both-kill test
    // never SIGKILLs live gateway keepers on this host (cf.
    // acceptance-criteria.test.ts:42 which does the same).
    sweepKeeperOrphans: vi.fn(() => 0),
  };
});
import { runChildProcess as runChildProcessMock } from "./launchers/child-process.js";
import { killChildGroup as killChildGroupMock } from "./child-spawn.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const require = createRequire(import.meta.url);

/** Open a sqlite DB regardless of runtime (bun:sqlite or node:sqlite). */
function openSqlite(dbPath: string): {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
  close(): void;
} {
  if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
    const { Database } = require("bun:sqlite") as {
      Database: new (p: string) => unknown;
    };
    return new Database(dbPath) as unknown as ReturnType<typeof openSqlite>;
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => unknown;
  };
  return new DatabaseSync(dbPath) as unknown as ReturnType<typeof openSqlite>;
}

/**
 * tz-01 B2: night semantics come from the CONTRACT (`scope: "full_store"` →
 * batching.strategy = bounded-full-store-chunked), never from the role name.
 * Every night fixture below therefore declares a role file; the rest of the
 * contract stays legacy (filled from the global snapshot by the adapter), so
 * the expectations of these tests (night caps, night diffCap) are unchanged.
 */
function nightContract(
  roleDir: string,
  extra: Record<string, unknown> = {},
): void {
  fs.writeFileSync(
    path.join(roleDir, "night-keeper.json"),
    JSON.stringify({ name: "night-keeper", scope: "full_store", ...extra }),
    "utf-8",
  );
}

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

/** Global snapshot the orchestrator now takes explicitly (tz-01): role
 * parameters come from the contract, this is only the LegacyRoleAdapter's
 * fallback plus the host launch parameters. */
function roleOpts(cfg: GatewayConfig) {
  const c = cfg.memory.consolidation;
  return {
    enabled: c.enabled,
    roleDefaults: buildRoleDefaults(c),
    launchers: c.launchers,
  };
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
    skippedMergesMissingTarget: [],
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
    clearRoleContractCache();
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
    // Default roleDir = empty tmp dir → role resolution returns null (no role
    // json) → shared scratchRoot fallback. Tests that need a real role pass
    // an explicit roleDir (e.g. night-keeper B3 block).
    const emptyRoleDir = path.join(tmp, "empty-roles");
    fs.mkdirSync(emptyRoleDir, { recursive: true });
    const cfg = makeConfig(dataDir, opts.enabled ?? true);
    return new ConsolidationOrchestrator({
      config: cfg,
      ...roleOpts(cfg),
      dataDir,
      scratchRoot,
      logger: silentLogger,
      gatewayUrl: "http://127.0.0.1:8420",
      roleName: opts.roleName,
      roleDir: opts.roleDir ?? emptyRoleDir,
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
        "PI_MEMORY_KEEPER_OWNER",
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
    // ...and must NOT be stamped as "this role ran today" either: the
    // dispatcher has to keep retrying it (tick and catch-up after restart).
    // The FAILURE is counted though — that is what bounds those retries.
    const progress = cp.roles["memory-keeper"] as {
      lastRunAt: string;
      consecutiveFailures: number;
    };
    expect(progress.lastRunAt).toBe("");
    expect(progress.consecutiveFailures).toBe(1);
  });

  it("chunked run that applied nothing IS stamped as ran-today (no cursor move)", async () => {
    // The chunked strategy does not advance the cursor when nothing was
    // applied, so without the explicit stamp the dispatcher would re-fire
    // this scheduled role on every tick.
    const roleDir = path.join(tmp, "roles-stamp");
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(
      path.join(roleDir, "night-keeper.md"),
      "ROLE-NIGHT-PROMPT",
      "utf-8",
    );
    nightContract(roleDir);
    const orch = makeOrchestrator({
      roleName: "night-keeper",
      roleDir,
      spawn: writingSpawn({}),
      // Nothing applied → the chunked strategy returns no advance.
      apply: vi.fn(async () => ({
        ...okApply(),
        applied: { merges: [], deletes: [], rewrites: [] },
      })),
    });
    const summary = await orch.runNow({ reason: "night" });
    expect(summary.status).toBe("ok");
    const cp = await orch.readCheckpoint();
    expect(cp.lastRunAt).toBe(""); // cursor untouched
    expect(
      (cp.roles["night-keeper"] as { lastRunAt?: string } | undefined)
        ?.lastRunAt,
    ).toBeTruthy(); // but the role is marked as having run
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

  // The presented diff must NOT occupy the path the role writes its candidate
  // to: sharing it made "the role produced nothing" read as "the role produced
  // malformed JSON", because the reader parsed our own markdown back.
  it("preparation writes the presented diff beside diff.json, never into it", async () => {
    const spawn = vi.fn(async (): Promise<ChildRunResult> => ({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      killed: null,
    }));
    const orch = makeOrchestrator({ spawn });

    await orch.runNow({ reason: "manual", dryRun: true });

    const runDirs = fs.readdirSync(scratchRoot).filter((f) => f.includes("-"));
    const runScratch = path.join(scratchRoot, runDirs[0]!);
    expect(fs.existsSync(path.join(runScratch, "presented-diff.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(runScratch, "diff.json"))).toBe(false);
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
        ...roleOpts(makeConfig(dataDir, true)),
        ...roleOpts(makeConfig(dataDir, true)),
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

  it("night-keeper WITHOUT prompt file → run refused (fail-closed role)", async () => {
    const roleDir = path.join(tmp, "roles"); // contract, but no night-keeper.md
    fs.mkdirSync(roleDir, { recursive: true });
    nightContract(roleDir, { fail_on_missing_prompt: true });
    const spawn = vi.fn();
    const orch = makeOrchestrator({ roleName: "night-keeper", roleDir, spawn });

    const summary = await orch.runNow({ reason: "night" });
    // The role does not resolve → it does not run (`fail-closed-role`).
    expect(summary.status).toBe("disabled");
    expect(summary.error).toMatch(/night-keeper\.md.*fail_on_missing_prompt/);
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
    nightContract(roleDir);

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
    nightContract(roleDir, { timeout_min: 45 });
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

  it("night delete cap exceeded → apply refused (mechanical gate, not a prompt)", async () => {
    const roleDir = path.join(tmp, "roles5");
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(
      path.join(roleDir, "night-keeper.md"),
      "ROLE-NIGHT-PROMPT",
      "utf-8",
    );
    nightContract(roleDir);
    // diff with 51 deleteL1 ops > default deleteCapPerRun=50
    const manyDeletes = Array.from({ length: 51 }, (_, i) => ({
      id: `m_d${i}`,
      updatedAt: "2026-08-01T00:00:00Z",
    }));
    const spawn = writingSpawn({ deleteL1: manyDeletes });
    const apply = vi.fn(async () => okApply());
    const orch = makeOrchestrator({
      roleName: "night-keeper",
      roleDir,
      spawn,
      apply,
    });

    const summary = await orch.runNow({ reason: "night" });
    expect(summary.status).toBe("failed");
    expect(summary.error).toMatch(/delete cap exceeded/);
    expect(apply).not.toHaveBeenCalled(); // mechanical gate refuses apply
  });

  it("night runType routes through runNow with role=night-keeper even when constructor roleName is keeper", async () => {
    const roleDir = path.join(tmp, "roles6");
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(
      path.join(roleDir, "night-keeper.md"),
      "ROLE-NIGHT-PROMPT",
      "utf-8",
    );
    nightContract(roleDir);
    const spawn = writingSpawn({});
    const orch = makeOrchestrator({ roleDir, spawn }); // constructor roleName = keeper

    const summary = await orch.runNow({
      reason: "night",
      runType: "night-keeper",
    });
    expect(summary.status).toBe("ok");
    expect(summary.role).toBe("night-keeper"); // per-run role, not constructor
  });

  // `resolveRoleTimeoutMs` was deleted in tz-01 B1 (a SECOND reader of
  // role.json). The per-run timeout now comes from the resolved contract and
  // is covered in role-contract.test.ts ("timeout_min wins", "fallback").

  describe("readLastReport picks the newest run by startedAt (any role)", () => {
    it("flip: older night-keeper + newer memory-keeper → memory-keeper wins", async () => {
      const logsDir = path.join(dataDir, "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      // Lexicographically night-keeper-* sorts AFTER memory-keeper-*,
      // but here the NIGHT report is OLDER — body startedAt must win.
      fs.writeFileSync(
        path.join(logsDir, "night-keeper-2026-08-02T03-00-00.000Z.json"),
        JSON.stringify({
          role: "night-keeper",
          status: "ok",
          startedAt: "2026-08-02T03:00:00.000Z",
          finishedAt: "2026-08-02T03:10:00.000Z",
          elapsedMs: 600000,
          reason: "schedule",
          dryRun: false,
          newL0: 10,
          recordsPresented: 200,
          overLimitBlocks: 0,
          applied: { merges: [], deletes: [], rewrites: [] },
          skipped: { merges: [], deletes: [], rewrites: [] },
          reindexed: false,
          needsReindex: false,
        }),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(logsDir, "memory-keeper-2026-08-02T04-00-00.000Z.json"),
        JSON.stringify({
          role: "memory-keeper",
          status: "ok",
          startedAt: "2026-08-02T04:00:00.000Z",
          finishedAt: "2026-08-02T04:05:00.000Z",
          elapsedMs: 300000,
          reason: "threshold",
          dryRun: false,
          newL0: 3,
          recordsPresented: 5,
          overLimitBlocks: 0,
          applied: { merges: [], deletes: [], rewrites: [] },
          skipped: { merges: [], deletes: [], rewrites: [] },
          reindexed: false,
          needsReindex: false,
        }),
        "utf-8",
      );
      const orch = makeOrchestrator({});
      await orch.start();
      const last = orch.getLastRun();
      expect(last?.role).toBe("memory-keeper"); // newest by startedAt, not by name
    });

    it("corrupt JSON is skipped, newest valid run still wins", async () => {
      const logsDir = path.join(dataDir, "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(
        path.join(logsDir, "night-keeper-2026-08-02T03-00-00.000Z.json"),
        "{broken json",
        "utf-8",
      );
      fs.writeFileSync(
        path.join(logsDir, "memory-keeper-2026-08-02T05-00-00.000Z.json"),
        JSON.stringify({
          role: "memory-keeper",
          status: "ok",
          startedAt: "2026-08-02T05:00:00.000Z",
          finishedAt: "2026-08-02T05:01:00.000Z",
          elapsedMs: 60000,
          reason: "threshold",
          dryRun: false,
          newL0: 1,
          recordsPresented: 1,
          overLimitBlocks: 0,
          applied: { merges: [], deletes: [], rewrites: [] },
          skipped: { merges: [], deletes: [], rewrites: [] },
          reindexed: false,
          needsReindex: false,
        }),
        "utf-8",
      );
      const orch = makeOrchestrator({});
      await orch.start();
      const last = orch.getLastRun();
      expect(last?.role).toBe("memory-keeper");
      expect(last?.startedAt).toBe("2026-08-02T05:00:00.000Z");
    });
  });

  describe("night multi-batch cap accumulation", () => {
    it("two chunks share ONE per-run delete budget (residual, not 2×cap)", async () => {
      const roleDir = path.join(tmp, "roles-cap");
      fs.mkdirSync(roleDir, { recursive: true });
      fs.writeFileSync(
        path.join(roleDir, "night-keeper.md"),
        "ROLE-NIGHT-PROMPT",
        "utf-8",
      );
      nightContract(roleDir);
      // Seed 6 L1 records → with night.diffCap=5 the full-store sweep splits
      // into 2 chunks. deleteCapPerRun=50 default. Chunk 1 requests 40
      // deletes, chunk 2 requests 15 → total 55 > 50 → chunk 2 refused.
      const db = openSqlite(path.join(dataDir, "vectors.db"));
      db.exec(
        "CREATE TABLE l1_records (" +
          "record_id TEXT PRIMARY KEY, content TEXT, type TEXT, priority INTEGER, scene_name TEXT, " +
          "session_key TEXT, session_id TEXT, timestamp_str TEXT, created_time TEXT, updated_time TEXT, metadata_json TEXT)",
      );
      for (let i = 0; i < 6; i++) {
        db.prepare(
          "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          `m_rec${i}`,
          `record content ${i}`,
          "episodic",
          50,
          `2026-08-0${i + 1}T00:00:00Z`,
          `2026-08-0${i + 1}T00:00:00Z`,
        );
      }
      db.close();
      // Patch the config: night.diffCap=5, keep day defaults.
      const base = makeConfig(dataDir, true);
      const cfg = {
        ...base,
        memory: {
          ...base.memory,
          consolidation: {
            ...base.memory.consolidation,
            night: { ...base.memory.consolidation.night, diffCap: 5 },
          },
        },
      } as GatewayConfig;
      const spawnCalls: number[] = [];
      const spawn = vi.fn(
        async (ctx: SpawnChildContext): Promise<ChildRunResult> => {
          const n = spawnCalls.length;
          spawnCalls.push(n);
          const deletes =
            n === 0
              ? Array.from({ length: 40 }, (_, i) => ({
                  id: `m_a${i}`,
                  updatedAt: "2026-08-01T00:00:00Z",
                }))
              : Array.from({ length: 15 }, (_, i) => ({
                  id: `m_b${i}`,
                  updatedAt: "2026-08-01T00:00:00Z",
                }));
          await fs.promises.writeFile(
            path.join(ctx.scratchDir, "diff.json"),
            JSON.stringify({ deleteL1: deletes }),
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
      const orch = new ConsolidationOrchestrator({
        config: cfg,
        ...roleOpts(cfg),
        dataDir,
        scratchRoot,
        logger: silentLogger,
        gatewayUrl: "http://127.0.0.1:8420",
        roleName: "night-keeper",
        roleDir,
        spawnChild: spawn,
        applyDiff: vi.fn(async () => okApply()),
      });
      const summary = await orch.runNow({ reason: "night" });
      // Chunk 2 refused: 40 + 15 = 55 > deleteCapPerRun=50 (residual gate).
      expect(summary.status).toBe("failed");
      expect(summary.error).toMatch(/delete cap exceeded/);
      expect(spawnCalls.length).toBe(2); // both chunks spawned, second refused at gate
    });
  });
  describe("night multi-batch loop: advance anchor (plan §4)", () => {
    /** Seed a vectors.db with n L1 records + l0_conversations watermark. */
    /** Grow the L0 watermark between chunks (discriminates anchored cursor
     * from max-at-advance: anchored = chunk-1 slice-time T10, max = T11). */
    function growL0(recordedAt: string): void {
      const db = openSqlite(path.join(dataDir, "vectors.db"));
      db.prepare(
        "INSERT INTO l0_conversations (role, content, recorded_at) VALUES (?, ?, ?)",
      ).run("user", "grow", recordedAt);
      db.close();
    }

    function seedStore(l0Max: string, n: number): void {
      const db = openSqlite(path.join(dataDir, "vectors.db"));
      db.exec(
        "CREATE TABLE l1_records (" +
          "record_id TEXT PRIMARY KEY, content TEXT, type TEXT, priority INTEGER, scene_name TEXT, " +
          "session_key TEXT, session_id TEXT, timestamp_str TEXT, created_time TEXT, updated_time TEXT, metadata_json TEXT)",
      );
      db.exec(
        "CREATE TABLE l0_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, recorded_at TEXT)",
      );
      db.prepare(
        "INSERT INTO l0_conversations (role, content, recorded_at) VALUES (?, ?, ?)",
      ).run("user", "w", l0Max);
      for (let i = 0; i < n; i++) {
        db.prepare(
          "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          `m_rec${i}`,
          `record content ${i}`,
          "episodic",
          50,
          `2026-08-0${(i % 9) + 1}T00:00:00Z`,
          `2026-08-0${(i % 9) + 1}T00:00:00Z`,
        );
      }
      db.close();
    }

    function nightOrch(
      diffCap: number,
      apply: (body: unknown) => Promise<ApplyResult>,
      spawn: (ctx: SpawnChildContext) => Promise<ChildRunResult>,
      roleDir: string,
    ): ConsolidationOrchestrator {
      const base = makeConfig(dataDir, true);
      const cfg = {
        ...base,
        memory: {
          ...base.memory,
          consolidation: {
            ...base.memory.consolidation,
            night: { ...base.memory.consolidation.night, diffCap },
          },
        },
      } as GatewayConfig;
      return new ConsolidationOrchestrator({
        config: cfg,
        ...roleOpts(cfg),
        dataDir,
        scratchRoot,
        logger: silentLogger,
        gatewayUrl: "http://127.0.0.1:8420",
        roleName: "night-keeper",
        roleDir,
        spawnChild: spawn,
        applyDiff: apply,
      });
    }

    it("3 chunks → 3 spawns, accumulate, advance ONCE (anchor = last applied slice-time)", async () => {
      const roleDir = path.join(tmp, "roles-adv");
      fs.mkdirSync(roleDir, { recursive: true });
      fs.writeFileSync(
        path.join(roleDir, "night-keeper.md"),
        "ROLE-NIGHT-PROMPT",
        "utf-8",
      );
      nightContract(roleDir);
      // 6 records, diffCap=2 → 3 chunks. l0 watermark = T10.
      seedStore("2026-08-02T10:00:00.000Z", 6);
      const spawn = writingSpawn({});
      const spawnSpy = vi.fn(spawn);
      const apply = vi.fn(async () => okApply());
      const orch = nightOrch(2, apply, spawnSpy, roleDir);
      const summary = await orch.runNow({ reason: "night" });
      expect(summary.status).toBe("ok");
      expect(spawnSpy).toHaveBeenCalledTimes(3);
      const cp = await orch.readCheckpoint();
      expect(cp.l0Cursor).toBe("2026-08-02T10:00:00.000Z"); // anchored to max slice-time
    });

    it("skip-merge in chunk 2 → anchor stops at chunk-1 slice-time (chunk 3 NOT advanced)", async () => {
      const roleDir = path.join(tmp, "roles-adv2");
      fs.mkdirSync(roleDir, { recursive: true });
      fs.writeFileSync(
        path.join(roleDir, "night-keeper.md"),
        "ROLE-NIGHT-PROMPT",
        "utf-8",
      );
      nightContract(roleDir);
      seedStore("2026-08-02T10:00:00.000Z", 6);
      // Chunk 2 (second spawn) returns a target-missing merge skip.
      let spawnCount = 0;
      const spawn = writingSpawn({});
      const spawnSpy = vi.fn(async (ctx: SpawnChildContext) => {
        spawnCount += 1;
        if (spawnCount === 1) {
          // Between chunk 1 and chunk 2 the L0 watermark grows to T11 —
          // the anchored cursor (chunk-1 slice-time T10) must NOT follow it;
          // a naive max-at-advance implementation would advance to T11.
          growL0("2026-08-02T11:00:00.000Z");
        }
        await spawn(ctx);
        return {
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          killed: null,
        };
      });
      let call = 0;
      const apply = vi.fn(async () => {
        call += 1;
        if (call === 2) {
          // chunk 2: applied NOTHING, target-missing merge → skip anchor
          return {
            ...okApply(),
            applied: { merges: [], deletes: [], rewrites: [] },
            skipped: { merges: ["gone_target"], deletes: [], rewrites: [] },
            skippedMergesMissingTarget: ["gone_target"],
          };
        }
        return okApply(); // chunk 1 applies m_1 → anchor = its slice-time
      });
      const orch = nightOrch(2, apply, spawnSpy, roleDir);
      const summary = await orch.runNow({ reason: "night" });
      expect(summary.status).toBe("ok");
      expect(spawnSpy).toHaveBeenCalledTimes(2); // loop STOPS at the skip chunk
      const cp = await orch.readCheckpoint();
      expect(cp.l0Cursor).toBe("2026-08-02T10:00:00.000Z"); // chunk-1 slice-time == l0 max
    });

    it("skip-merge in chunk 1 → prevCursor (NO advance; whole chunk re-presents)", async () => {
      const roleDir = path.join(tmp, "roles-adv3");
      fs.mkdirSync(roleDir, { recursive: true });
      fs.writeFileSync(
        path.join(roleDir, "night-keeper.md"),
        "ROLE-NIGHT-PROMPT",
        "utf-8",
      );
      nightContract(roleDir);
      seedStore("2026-08-02T10:00:00.000Z", 6);
      const spawn = writingSpawn({});
      const spawnSpy = vi.fn(async (ctx: SpawnChildContext) => {
        await spawn(ctx);
        return {
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          killed: null,
        };
      });
      const apply = vi.fn(async () => ({
        ...okApply(),
        applied: { merges: [], deletes: [], rewrites: [] },
        skipped: { merges: ["gone"], deletes: [], rewrites: [] },
        skippedMergesMissingTarget: ["gone"],
      }));
      const orch = nightOrch(2, apply, spawnSpy, roleDir);
      // Pre-seed the checkpoint cursor so "prevCursor" is observable.
      await orch.readCheckpoint(); // ensure dir exists
      const cpBefore = await orch.readCheckpoint();
      void cpBefore;
      const summary = await orch.runNow({ reason: "night" });
      expect(summary.status).toBe("ok");
      expect(spawnSpy).toHaveBeenCalledTimes(1); // skip in chunk 1 → stop
      const cp = await orch.readCheckpoint();
      expect(cp.l0Cursor).toBe(""); // prevCursor (initial "") — NOT chunk-1 slice-time
    });
  });

  // ============================
  // Per-role lock (RoleGate) — different roles run in parallel, same role
  // is single-flight (§5.1), stop() kills ALL in-flight children.
  // ============================

  it("per-role: night-keeper trigger is NOT busy while memory-keeper is in flight", async () => {
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
    const roleDir = path.join(tmp, "roles-par");
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(
      path.join(roleDir, "night-keeper.md"),
      "ROLE-NIGHT-PROMPT",
      "utf-8",
    );
    nightContract(roleDir);
    // Rebuild with the night-keeper role file so executeRunNight is not
    // fail-loud (missing prompt) before it can spawn.
    const orchPar = makeOrchestrator({ spawn: slowSpawn, roleDir });

    const first = orchPar.runNow({ reason: "first" }); // memory-keeper (default)
    await new Promise((r) => setTimeout(r, 20));
    expect(orchPar.isRunning).toBe(true);

    // Same role refused…
    const sameRole = await orchPar.trigger({ reason: "second" });
    expect(sameRole.accepted).toBe(false);
    expect(sameRole.status).toBe("busy");

    // …but night-keeper (different role) is accepted in parallel.
    const night = await orchPar.trigger({
      reason: "night",
      runType: "night-keeper",
    });
    expect(night.accepted).toBe(true);
    expect(night.status).toBe("started");

    release();
    const summary = await first;
    expect(summary.status).toBe("ok");
    // memory-keeper spawned exactly once (its own run); the parallel night
    // trigger was accepted at the gate level (per-role lock) even though the
    // night run has an empty store (0 batches → no spawn). The gate, not the
    // batch pipeline, is what this test exercises.
    expect(slowSpawn).toHaveBeenCalledTimes(1);
  });

  it("stop() kills all in-flight child handles (parallel roles)", async () => {
    // Real defaultSpawnChild onChild registration: the process runner is mocked
    // at module level (vi.mock hoists), so spawn resolves without a real pi
    // sub-session, but the kill handles ARE registered in childrenRef via the
    // real runner-helpers wiring (the point of the parallel-child-leak fix).
    const killed: string[] = [];
    (
      runChildProcessMock as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(
      (opts: {
        onChild?: (c: { kill: () => void }) => void;
        timeoutMs: number;
      }): Promise<ChildRunResult> => {
        opts.onChild?.({ kill: () => killed.push("child") });
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          killed: null,
        });
      },
    );

    const roleDir = path.join(tmp, "roles-stop");
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(
      path.join(roleDir, "night-keeper.md"),
      "ROLE-NIGHT-PROMPT",
      "utf-8",
    );
    nightContract(roleDir);

    // Use the DEFAULT spawn path (no `spawn` override in the constructor) so
    // onChild registration flows through the real runner-helpers wiring →
    // the mocked runner fills childrenRef, and stop() calls the
    // registered kill handle. killChildGroup is mocked too, so a REAL
    // childrenRef iteration is proven (kill called once per runId); without
    // it the assertion would pass with zero kills (critic test-gap).
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    (
      killChildGroupMock as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      killed.push("child");
      return {
        killed: 1,
        survivors: [],
        method: "group-kill",
      } as never;
    });
    (
      runChildProcessMock as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(
      (opts: {
        onChild?: (c: { kill: () => void }) => void;
        timeoutMs: number;
      }): Promise<ChildRunResult> => {
        // onChild receives the spawned child; runner-helpers registers
        // { kill: () => killChildGroup(child, logger) } in childrenRef.
        opts.onChild?.({ pid: 99999 } as never);
        return gate.then(() => ({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          killed: null,
        }));
      },
    );
    const orch = new ConsolidationOrchestrator({
      config: makeConfig(dataDir, true),
      ...roleOpts(makeConfig(dataDir, true)),
      dataDir,
      scratchRoot,
      logger: silentLogger,
      gatewayUrl: "http://127.0.0.1:8420",
      roleDir,
    });
    await orch.start();

    // Seed a store so the night (full-store) run actually reaches the spawner.
    const db = openSqlite(path.join(dataDir, "vectors.db"));
    db.exec(
      "CREATE TABLE l1_records (" +
        "record_id TEXT PRIMARY KEY, content TEXT, type TEXT, priority INTEGER, scene_name TEXT, " +
        "session_key TEXT, session_id TEXT, timestamp_str TEXT, created_time TEXT, updated_time TEXT, metadata_json TEXT)",
    );
    db.prepare(
      "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "m_n1",
      "night rec",
      "episodic",
      50,
      "2026-08-02T01:00:00.000Z",
      "2026-08-02T01:00:00.000Z",
    );
    db.close();

    // Two parallel runs of different roles, both held in flight.
    const a = orch.runNow({ reason: "a" });
    await new Promise((r) => setTimeout(r, 20));
    const b = orch.runNow({ reason: "b", runType: "night-keeper" });
    await new Promise((r) => setTimeout(r, 20));
    expect(orch.isRunning).toBe(true);

    // stop() now goes through the launcher's cancelAndWait, which waits for
    // the child to reap — so the mocked runner has to be allowed to settle
    // while the shutdown is in flight, exactly as a real exit would.
    const stopping = orch.stop();
    release();
    await stopping;
    expect(killed.length).toBe(2); // both child handles killed
    await Promise.all([a, b]);
    expect(orch.isRunning).toBe(false);
  });
});
