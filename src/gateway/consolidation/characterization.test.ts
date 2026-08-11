/**
 * Ф0 characterization for tz-01 (model §8 step 1) — parity digest of the
 * SPAWN SURFACE of every live role, pinned BEFORE the contract resolver and
 * the unified runner land.
 *
 * What is pinned (must NOT change when execution moves from global config to
 * the role contract, criterion 9 "parity-shadow ... по digest"):
 *   spawnFlags, extraArgs (--extension/--skill), model, thinking, timeoutMs,
 *   the role part of the system prompt, and the *.py listing of <scratch>/tools.
 *
 * What is deliberately NOT pinned, because tz-01 changes it on purpose:
 *   - the diff section of the prompt (idsOnly/diffCap differ per strategy);
 *   - non-*.py entries under tools/ (today the WHOLE keeper-tools dir is
 *     copied incl. __pycache__; criterion 3 makes it tools_subset only).
 *
 * Batching semantics themselves (fresh-tail single batch, bounded chunked
 * sweep with anchored cursor and residual cap budget) are already
 * characterized in orchestrator.test.ts — not duplicated here.
 *
 * Hermetic: fixture roles in a tmp dir, never ~/.pi/agent-memory/tdai/roles.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseConfig } from "../../config.js";
import { ConsolidationOrchestrator } from "./orchestrator.js";
import { buildRoleDefaults } from "../role-defaults.js";
import type { GatewayConfig } from "../config.js";
import type { Logger } from "../../core/types.js";
import { createRequire } from "node:module";
import { RESULT_REL } from "./attempt-layout.js";

// tz-06 Ф5b: every host now goes through ONE process runner, so the surface
// is captured as the child's real argv instead of pi's pre-split option bag.
// Same information, one layer lower — and host-agnostic, which is the point.
vi.mock("./launchers/child-process.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./launchers/child-process.js")>();
  return { ...actual, runChildProcess: vi.fn() };
});
vi.mock("./child-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./child-spawn.js")>();
  return {
    ...actual,
    killChildGroup: vi.fn(),
    sweepKeeperOrphans: vi.fn(() => 0),
  };
});
import { runChildProcess as runChildProcessMock } from "./launchers/child-process.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const require = createRequire(import.meta.url);

function openSqlite(dbPath: string): {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): void };
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

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** The three live role contracts, copied verbatim from
 * ~/.pi/agent-memory/tdai/roles/<role>/role.json (2026-08-10) with only the
 * absolute runtime paths rewritten into the fixture dir. `model`/`thinking`
 * equal the global config values on purpose: parity means the SAME bundle,
 * so the digest must not move when the source of those values changes. */
const ROLE_FIXTURES: Record<string, Record<string, unknown>> = {
  "memory-keeper": {
    name: "memory-keeper",
    model: "opencode-go/deepseek-v4-flash",
    prompt_file: "memory-keeper.md",
    enabled: true,
    thinking: "low",
    timeout_min: 30,
    scope: "fresh_tail",
    trigger: "threshold",
    schedule: null,
    threshold: 50,
    idsOnly: false,
    diff_cap: 20,
    diff_byte_cap: 8192,
    ops_subset: ["deleteL1", "merge", "rewriteBlock", "rewritePersona"],
    tools_subset: [
      "fetch_dups.py",
      "fetch_blocks.py",
      "fetch_records.py",
      "dump_bullets.py",
    ],
    caps: { delete_per_run: 50, rewrite_per_run: 50 },
    max_run_ms: 1_800_000,
    fail_on_missing_prompt: false,
    critic_role: "memory-critic",
  },
  "night-keeper": {
    name: "night-keeper",
    model: "opencode-go/deepseek-v4-flash",
    prompt_file: "night-keeper.md",
    enabled: true,
    thinking: "low",
    timeout_min: 45,
    scope: "full_store",
    trigger: "schedule",
    schedule: "06:00",
    threshold: null,
    idsOnly: true,
    diff_cap: 200,
    diff_byte_cap: 524_288,
    ops_subset: [
      "deleteL1",
      "merge",
      "rewriteRecord",
      "rewriteBlock",
      "rewritePersona",
    ],
    tools_subset: [
      "fetch_dups.py",
      "fetch_blocks.py",
      "fetch_records.py",
      "dump_bullets.py",
    ],
    caps: { delete_per_run: 50, rewrite_per_run: 50 },
    max_run_ms: 2_700_000,
    fail_on_missing_prompt: true,
    critic_role: "night-critic",
  },
  "dedup-daily": {
    name: "dedup-daily",
    model: "opencode-go/deepseek-v4-flash",
    prompt_file: "dedup-daily.md",
    enabled: true,
    thinking: "low",
    timeout_min: 60,
    scope: "full_store",
    trigger: "schedule",
    schedule: "03:00",
    threshold: null,
    idsOnly: true,
    diff_cap: 200,
    diff_byte_cap: 524_288,
    ops_subset: ["deleteL1", "merge"],
    tools_subset: ["fetch_dups.py", "fetch_records.py"],
    caps: { delete_per_run: 100, rewrite_per_run: 0 },
    max_run_ms: 3_600_000,
    fail_on_missing_prompt: true,
    critic_role: "dedup-daily-critic",
  },
};

/** Everything the child launch is made of, minus the parts tz-01 changes. */
interface SpawnSurface {
  spawnFlags: string[];
  extraArgs: string[];
  model: string;
  thinking: string;
  timeoutMs: number;
  rolePrompt: string;
  tools: string[];
}

function digest(s: SpawnSurface): string {
  return createHash("sha256")
    .update(JSON.stringify(s))
    .digest("hex")
    .slice(0, 16);
}

describe("Ф0 characterization — role spawn surface (tz-01 parity baseline)", () => {
  let tmp: string;
  let dataDir: string;
  let roleDir: string;
  let scratchRoot: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-char-"));
    dataDir = path.join(tmp, "tdai");
    scratchRoot = path.join(tmp, "scratch");
    roleDir = path.join(tmp, "roles");
    fs.mkdirSync(dataDir, { recursive: true });
    for (const [role, cfg] of Object.entries(ROLE_FIXTURES)) {
      const dir = path.join(roleDir, role);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "role.json"),
        JSON.stringify({
          ...cfg,
          runtime: {
            extension_path: path.join(tmp, "ext", role, "index.ts"),
            skill_path: path.join(tmp, "skills", role, "SKILL.md"),
            scratch_root: path.join(tmp, "runs", role),
          },
        }),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(dir, "prompt.md"),
        `ROLE-PROMPT-${role}`,
        "utf-8",
      );
    }
    const db = openSqlite(path.join(dataDir, "vectors.db"));
    db.exec(
      "CREATE TABLE l1_records (record_id TEXT PRIMARY KEY, content TEXT, type TEXT, " +
        "priority INTEGER, scene_name TEXT, session_key TEXT, session_id TEXT, " +
        "timestamp_str TEXT, created_time TEXT, updated_time TEXT, metadata_json TEXT)",
    );
    db.exec(
      "CREATE TABLE l0_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, " +
        "content TEXT, recorded_at TEXT)",
    );
    db.prepare(
      "INSERT INTO l0_conversations (role, content, recorded_at) VALUES (?, ?, ?)",
    ).run("user", "w", "2026-08-05T00:00:00Z");
    db.prepare(
      "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "m_1",
      "content one",
      "episodic",
      50,
      "2026-08-01T00:00:00Z",
      "2026-08-01T00:00:00Z",
    );
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Split a real argv back into the surface the assertions talk about:
   * fixed flags, instance assets, then the contract-driven tail. */
  function splitArgv(argv: string[]) {
    const assetAt = argv.findIndex((a) =>
      ["--no-extensions", "--extension", "--skill"].includes(a),
    );
    const modelAt = argv.indexOf("--model");
    const at = (flag: string): string => argv[argv.indexOf(flag) + 1] ?? "";
    return {
      spawnFlags: argv.slice(0, assetAt < 0 ? modelAt : assetAt),
      extraArgs: assetAt < 0 ? [] : argv.slice(assetAt, modelAt),
      model: at("--model"),
      thinking: at("--thinking"),
      systemPromptPath: at("--system-prompt"),
    };
  }

  /** Run one role with the REAL defaultSpawnChild (the process runner mocked)
   * and return the surface the child would have been launched with. */
  async function captureSurface(role: string): Promise<SpawnSurface> {
    let captured: Record<string, unknown> | null = null;
    // The run scratch dir is REMOVED in the runner's finally block after every
    // non-dry run (day-runner.ts:119 / night-runner.ts:112), so prompt and
    // tools must be read here, while the child would still see them.
    let promptText = "";
    let tools: string[] = [];
    (
      runChildProcessMock as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async (opts: Record<string, unknown>) => {
      captured = { ...opts, ...splitArgv(opts.args as string[]) };
      const scratchDir = String(opts.cwd);
      promptText = fs.readFileSync(
        String((captured as Record<string, unknown>).systemPromptPath),
        "utf-8",
      );
      try {
        tools = fs
          .readdirSync(path.join(scratchDir, "tools"))
          .filter((f) => f.endsWith(".py"))
          .sort();
      } catch {
        tools = [];
      }
      await fs.promises.writeFile(
        path.join(scratchDir, RESULT_REL),
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
    });
    const config = {
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
          enabled: true,
          diffCap: 10,
          diffByteCap: 4096,
          timeoutMs: 5000,
        },
        nightRun: { schedule: "06:00", threshold: 50, timezone: "system" },
      }),
    } as GatewayConfig;
    const orch = new ConsolidationOrchestrator({
      config,
      enabled: config.memory.consolidation.enabled,
      roleDefaults: buildRoleDefaults(config.memory.consolidation),
      launchers: config.memory.consolidation.launchers,
      dataDir,
      scratchRoot,
      logger: silentLogger,
      gatewayUrl: "http://127.0.0.1:8420",
      roleName: role,
      roleDir,
      applyDiff: async () => ({
        ok: true,
        status: "applied",
        partial: false,
        applied: { merges: [], deletes: [], rewrites: [] },
        skipped: { merges: [], deletes: [], rewrites: [] },
        skippedMergesMissingTarget: [],
        counts: null,
        reindexed: false,
        needsReindex: false,
        sceneIndexSynced: true,
      }),
    });
    await orch.runNow({ reason: "characterization", runType: role });
    if (captured === null) throw new Error(`no spawn captured for ${role}`);
    const opts = captured as Record<string, unknown>;
    // Role part = everything before the generated diff section.
    const rolePrompt = promptText.split("\n## ")[0]!.trim();
    return {
      // tz-06 Ф3: the last flag is a per-attempt session dir (fresh uuid every
      // run) — normalized so the digest tracks BEHAVIOR, not the uuid.
      spawnFlags: (opts.spawnFlags as string[]).map((a) =>
        a.startsWith(tmp) && a.endsWith("/session") ? "<SESSION>" : a,
      ),
      // The fixture root is a fresh mkdtemp per test — normalize it out, or
      // the digest changes on every run instead of on every behavior change.
      extraArgs: ((opts.extraArgs as string[]) ?? []).map((a) =>
        a.startsWith(tmp) ? `<TMP>${a.slice(tmp.length)}` : a,
      ),
      model: String(opts.model),
      thinking: String(opts.thinking),
      timeoutMs: Number(opts.timeoutMs),
      rolePrompt,
      tools,
    };
  }

  it("memory-keeper spawn surface is stable", async () => {
    const s = await captureSurface("memory-keeper");
    // tz-06 Ф3, `session-per-attempt`: `--no-session` is gone and the
    // launcher owns `--session-dir <scratch>/attempts/<attemptId>/session`.
    expect(s.spawnFlags).toEqual([
      "-p",
      "--no-context-files",
      "--session-dir",
      "<SESSION>",
    ]);
    expect(s.extraArgs).toEqual([
      "--no-extensions",
      "--extension",
      "<TMP>/ext/memory-keeper/index.ts",
      "--skill",
      "<TMP>/skills/memory-keeper/SKILL.md",
    ]);
    expect(s.model).toBe("opencode-go/deepseek-v4-flash");
    expect(s.thinking).toBe("low");
    expect(s.timeoutMs).toBe(30 * 60_000);
    expect(s.rolePrompt).toBe("ROLE-PROMPT-memory-keeper");
    expect(s.tools).toEqual([
      "dump_bullets.py",
      "fetch_blocks.py",
      "fetch_dups.py",
      "fetch_records.py",
    ]);
  });

  // tz-02 критерий 6: the model on the L2 path comes from the resolved
  // instance binding. The global config below names a DIFFERENT model on
  // purpose — if anything still read it, this is where it would show.
  it("model from binding — the role's model reaches the spawn, not the global one", async () => {
    fs.writeFileSync(
      path.join(roleDir, "memory-keeper", "role.json"),
      JSON.stringify({
        ...ROLE_FIXTURES["memory-keeper"],
        model: "probe/only-in-the-role",
        runtime: {
          extension_path: path.join(tmp, "ext", "memory-keeper", "index.ts"),
          skill_path: path.join(tmp, "skills", "memory-keeper", "SKILL.md"),
          scratch_root: path.join(tmp, "runs", "memory-keeper"),
        },
      }),
      "utf-8",
    );
    const s = await captureSurface("memory-keeper");
    expect(s.model).toBe("probe/only-in-the-role");
  });

  it("night-keeper spawn surface is stable", async () => {
    const s = await captureSurface("night-keeper");
    expect(s.model).toBe("opencode-go/deepseek-v4-flash");
    expect(s.timeoutMs).toBe(45 * 60_000);
    expect(s.rolePrompt).toBe("ROLE-PROMPT-night-keeper");
    expect(s.extraArgs[2]).toBe("<TMP>/ext/night-keeper/index.ts");
  });

  it("dedup-daily spawn surface is stable", async () => {
    const s = await captureSurface("dedup-daily");
    expect(s.model).toBe("opencode-go/deepseek-v4-flash");
    expect(s.timeoutMs).toBe(60 * 60_000);
    expect(s.rolePrompt).toBe("ROLE-PROMPT-dedup-daily");
  });

  it("tools are the contract's tools_subset, not the whole catalogue (criterion 3)", async () => {
    // The ONE intended surface change of tz-01: dedup-daily declares two of
    // the four scripts, and now receives exactly those two. memory-keeper and
    // night-keeper declare all four, so their surfaces stay byte-identical —
    // which is what the parity digests below assert.
    const dedup = await captureSurface("dedup-daily");
    expect(dedup.tools).toEqual(["fetch_dups.py", "fetch_records.py"]);
    const keeper = await captureSurface("memory-keeper");
    expect(keeper.tools).toEqual([
      "dump_bullets.py",
      "fetch_blocks.py",
      "fetch_dups.py",
      "fetch_records.py",
    ]);
  });

  it("parity digests of all three roles (criterion 9 — must not move)", async () => {
    const digests: Record<string, string> = {};
    for (const role of Object.keys(ROLE_FIXTURES)) {
      digests[role] = digest(await captureSurface(role));
    }
    // Pinned on the legacy path; the generic contract-driven path must
    // reproduce byte-identical surfaces. `dedup-daily` moved exactly once,
    // when tools stopped being the whole catalogue (see the test above);
    // memory-keeper and night-keeper never moved.
    expect(digests).toMatchInlineSnapshot(`
      {
        "dedup-daily": "9e4376acd7d43447",
        "memory-keeper": "84cb6a7d65762336",
        "night-keeper": "584b9512e9353b92",
      }
    `);
  });
});
