/**
 * P12 — acceptance tests for wave criteria §7 of the TZ (1-21).
 *
 * Covers the gaps the B1-B5 suites did not reach:
 *   - criterion 2: gateway restart → /status serves (integration, scratch
 *     dataDir + test port — never the real :8420 or ~/.pi/agent-memory);
 *   - criterion 9: memory-keeper role prompt mandates the task-simple cycle
 *     before writing persona/scenes (static read of the committed prompt);
 *   - criterion 18: behavioral values are configurable — no hardcoded model /
 *     schedule / timezone / spawn-flag literals in the new modules; defaults
 *     live in src/config.ts (static grep + parseConfig defaults);
 *   - criterion 20: negative INVARIANT static checks — L1 prompt 014808 in
 *     place, recall knobs not overridden, capture path LLM-free, write routes
 *     behind the loopback write-gate, role prompt is GET-only, no "--no-skills".
 *
 * Static checks read COMMITTED files relative to this module (works from a
 * fresh worktree). Integration boots a real TdaiGateway on a scratch dir.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TdaiGateway } from "./server.js";
import { parseConfig } from "../config.js";
import * as childSpawn from "./consolidation/child-spawn.js";
import { createRun } from "./control-plane/run-repo.js";

/**
 * Test-isolation (B6 R2, reviewer medium test-system-side-effect): a real
 * gateway boot calls orchestrator.start() → sweepKeeperOrphans(null) which
 * scans /proc for PI_MEMORY_KEEPER=1 processes and `kill -KILL`s them (no
 * active run → EVERY marker-carrying process is an orphan). A scratch gateway
 * booted by vitest would therefore SIGKILL a LIVE system keeper
 * (tdai-gateway.service mid-consolidation). Stub the sweep to a no-op for
 * this file's module graph so the test gateway never scans /proc and never
 * kills system processes. The regression assertion in the criterion-2 test
 * proves the dangerous call site is still reached — and intercepted.
 */
vi.mock("./consolidation/child-spawn.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./consolidation/child-spawn.js")>();
  return { ...actual, sweepKeeperOrphans: vi.fn(() => 0) };
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root: <repo>/src/gateway → <repo>. */
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Read a repo file as UTF-8; throws with a helpful message if missing. */
function readRepo(rel: string): string {
  const abs = path.join(REPO_ROOT, rel);
  return fs.readFileSync(abs, "utf-8");
}

// ============================
// Criterion 2 — gateway restart → /status ok
// ============================

describe("criterion 2 — gateway restart → /status serves (P12 integration)", () => {
  let tmp: string;
  let base: string;
  let port: number;
  let baseUrl: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-restart-"));
    base = path.join(tmp, "tdai");
    fs.mkdirSync(path.join(base, "scene_blocks", "_global"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(base, "records"), { recursive: true });
    port = 29_700 + Math.floor(Math.random() * 300);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeGateway(): TdaiGateway {
    return new TdaiGateway({
      data: { baseDir: base },
      server: { port, host: "127.0.0.1", corsOrigins: [] },
      memory: parseConfig({}),
    });
  }

  it("start → /status 200 → stop → restart on the SAME dataDir → /status 200 again", async () => {
    const first = makeGateway();
    await first.start();
    // Regression guard (B6 R2): the dangerous sweep site — start() with no
    // active run, which would SIGKILL every PI_MEMORY_KEEPER=1 process — is
    // reached by the test gateway, but the stubbed no-op intercepted it: no
    // /proc scan, no kill of system processes.
    expect(childSpawn.sweepKeeperOrphans).toHaveBeenCalledWith(
      null,
      expect.anything(),
      expect.any(Number),
    );
    try {
      const res = await fetch(`${baseUrl}/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        dataPath: string;
        consolidation: {
          enabled: boolean;
          checkpoint: string;
          inFlight: boolean;
        };
      };
      // "ok" with a live embedder; scratch boots fail-open as "degraded" —
      // both are serving states, never an error page.
      expect(["ok", "degraded"]).toContain(body.status);
      expect(body.dataPath).toBe(base);
      expect(body.consolidation.checkpoint).toContain(
        "consolidation_checkpoint.json",
      );
      expect(body.consolidation.inFlight).toBe(false);
      // Loopback token written OUTSIDE the dataDir (P2 contract).
      expect(fs.existsSync(path.join(tmp, "tdai-gateway.token"))).toBe(true);
    } finally {
      await first.stop();
    }

    // Restart — same dataDir, same port.
    const second = makeGateway();
    await second.start();
    try {
      const res = await fetch(`${baseUrl}/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        dataPath: string;
        consolidation: {
          checkpoint: string;
          inFlight: boolean;
          lastRun: unknown;
        };
      };
      expect(["ok", "degraded"]).toContain(body.status);
      expect(body.dataPath).toBe(base);
      expect(body.consolidation.checkpoint).toContain(
        "consolidation_checkpoint.json",
      );
      expect(body.consolidation.inFlight).toBe(false);

      // Discovery + write-gate survive the restart: the pi extension can
      // re-find the token and write routes stay behind it.
      const info = await fetch(`${baseUrl}/memory/info`);
      expect(info.status).toBe(200);
      const infoBody = (await info.json()) as { tokenPath: string };
      expect(infoBody.tokenPath).toContain("tdai-gateway.token");
      expect(fs.existsSync(infoBody.tokenPath)).toBe(true);

      const noAuth = await fetch(`${baseUrl}/memory/apply`, { method: "POST" });
      expect(noAuth.status).toBe(401);
      const token = fs.readFileSync(infoBody.tokenPath, "utf-8").trim();
      const post = (extra: Record<string, unknown>) =>
        fetch(`${baseUrl}/memory/apply`, {
          method: "POST",
          headers: {
            "x-memory-token": token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...extra,
            diff: {},
            manifest: { baseline: {} },
            context: { presentedRecordIds: [] },
          }),
        });

      // tz-09 criterion 1: past the write-gate is not past the run gate — an
      // apply that names no Run is refused before any mutation.
      const noRun = await post({});
      expect(noRun.status).toBe(400);
      expect(((await noRun.json()) as { error?: string }).error).toContain(
        "runId",
      );

      // With a live Run the same body applies — proves the write-gate itself
      // works post-restart (empty diff is valid).
      createRun(
        base,
        {
          runId: "run-acceptance",
          roleId: "memory-keeper",
          contractHash: "h",
          contractJson: "{}",
          binding: "{}",
        },
        new Date().toISOString(),
      );
      const authed = await post({ runId: "run-acceptance" });
      expect(authed.status).toBe(200);
    } finally {
      await second.stop();
    }
  });
});

// ============================
// Criterion 9 — persona through task-simple: role prompt mandates the cycle
// ============================

describe("criterion 9 — memory-keeper role prompt mandates the task-simple cycle", () => {
  const prompt = readRepo("src/core/prompts/memory-keeper.md");

  /** Collapse line-wrapping so multi-line prose phrases can be matched. */
  const flat = prompt.replace(/\s+/g, " ");

  it("instructs the task-simple cycle (crystal → plan → critic → impl) before writing persona/scenes", () => {
    expect(prompt).toContain("task-simple");
    expect(flat).toContain("кристалл → план → критик → импл");
  });

  it("redirects the task crystal/plan dir to <scratch-dir>/tasks (no ~/.pi/agent/tasks)", () => {
    expect(prompt).toContain("<scratch-dir>/tasks/");
    expect(prompt).toContain("НЕ пиши в `~/.pi/agent/tasks/`");
  });

  it("states the mechanical limits (scene 1500 / persona 2000) and the diff.json contract", () => {
    expect(prompt).toContain("≤ 1500 символов");
    expect(prompt).toContain("≤ 2000 символов");
    expect(prompt).toContain("diff.json");
    expect(flat).toContain(
      "ТОЛЬКО через POST /memory/apply со стороны гейтвея",
    );
  });

  it("forbids direct writes and POST routes — the sub-session is GET-only", () => {
    expect(prompt).toContain("Никаких POST-роутов");
    expect(prompt).toContain("только GET");
    expect(prompt).toContain("Никаких изменений памяти напрямую");
  });
});

// ============================
// Criterion 18 — configurability: no hardcoded behavioral values in new modules
// ============================

describe("criterion 18 — behavioral values are configurable, not hardcoded", () => {
  /** Modules added by wave P1-P11 (excludes config.ts, where defaults belong). */
  const NEW_MODULES = [
    "src/gateway/consolidation/child-spawn.ts",
    "src/gateway/consolidation/orchestrator.ts",
    "src/gateway/consolidation/diff-builder.ts",
    "src/gateway/consolidation/night-run.ts",
    "src/gateway/consolidation/checkpoint.ts",
    "src/gateway/memory-tools.ts",
    "src/gateway/token.ts",
    "src/gateway/write-auth.ts",
    "src/gateway/feedback.ts",
    "src/gateway/probe.ts",
    "src/gateway/reports.ts",
    "src/gateway/role-files.ts",
    "src/gateway/cleanup.ts",
  ];

  // Quoted code literals: comments mention these values, code must not.
  const HARDCODE_PATTERNS = [
    '"opencode-go/deepseek-v4-flash"', // consolidation.model default
    '?? "06:00"', // nightRun.schedule default
    '= "06:00"', // nightRun.schedule assignment
    '"Europe/Moscow"', // timezone default (must stay "system")
    '"--no-skills"', // spawn flag — banned by ТЗ §5.1
  ];

  it("no new module contains a hardcoded behavioral literal", () => {
    for (const rel of NEW_MODULES) {
      const src = readRepo(rel);
      for (const pattern of HARDCODE_PATTERNS) {
        expect(
          src.includes(pattern),
          `${rel} must not contain ${pattern}`,
        ).toBe(false);
      }
    }
  });

  it("dispatch values are injected, never built into the timer (tz-01 B6: they now come from the role contract)", () => {
    const nightRun = readRepo("src/gateway/consolidation/night-run.ts");
    // The timer only receives the zone and the contracts; schedule and
    // threshold belong to each role's `dispatch` block.
    expect(nightRun).toMatch(/timezone:\s*string/);
    expect(nightRun).toMatch(/listRoleContracts:/);
    expect(nightRun).not.toMatch(/\?\?\s*"06:00"/);
    expect(nightRun).not.toMatch(/=\s*"06:00"/);
    const dispatcher = readRepo("src/gateway/consolidation/dispatcher.ts");
    expect(dispatcher).toMatch(/c\.dispatch/);
    expect(dispatcher).not.toMatch(/"06:00"/);
  });

  it("the documented defaults live in src/config.ts (single source of truth)", () => {
    const cfg = readRepo("src/config.ts");
    expect(cfg).toContain('?? "opencode-go/deepseek-v4-flash"');
    expect(cfg).toContain('?? "06:00"');
    expect(cfg).toMatch(
      /threshold:\s*num\(nightRunGroup, "threshold"\) \?\? 50/,
    );
  });

  it("parseConfig({}) exposes those defaults through the config object", () => {
    const cfg = parseConfig({});
    expect(cfg.consolidation.model).toBe("opencode-go/deepseek-v4-flash");
    expect(cfg.consolidation.piBinary).toBeTruthy();
    expect(cfg.consolidation.spawnFlags).toContain("--no-context-files");
    expect(cfg.consolidation.spawnFlags).not.toContain("--no-skills");
    expect(cfg.consolidation.thinking).toBe("low");
    expect(cfg.consolidation.diffCap).toBe(20);
    expect(cfg.consolidation.diffByteCap).toBe(8 * 1024);
    expect(cfg.nightRun.schedule).toBe("06:00");
    expect(cfg.nightRun.threshold).toBe(50);
    expect(cfg.nightRun.timezone).toBe("system");
    expect(cfg.recall.typeWeights).toEqual({
      instruction: 1,
      persona: 1,
      episodic: 1,
    });
  });
});

// ============================
// Criterion 20 — negative INVARIANT static checks
// ============================

describe("criterion 20 — negative INVARIANT checks (static)", () => {
  it("nogo-l1-prompt: L1 prompt 014808 (критерий + исключения) and MAX_CONTENT_CHARS=600 stay in place", () => {
    const l1 = readRepo("src/core/prompts/l1-extraction.ts");
    expect(l1).toContain("Критерий");
    expect(l1).toContain("Не следует извлекать");
    const extractor = readRepo("src/core/record/l1-extractor.ts");
    expect(extractor).toMatch(/MAX_CONTENT_CHARS\s*=\s*600/);
  });

  it("nogo-recall-knobs: src/core never overrides the yaml knobs (scoreThreshold 0.85 / maxResults 3)", () => {
    // Built via concatenation so this test file itself never contains the
    // banned literal sequences.
    const pat = new RegExp(
      "scoreThreshold" + "\\s*=\\s*0\\.85|maxResults" + "\\s*=\\s*3",
    );
    const coreDir = path.join(REPO_ROOT, "src", "core");
    const offenders: string[] = [];
    for (const rel of walkTs(coreDir)) {
      const src = fs.readFileSync(path.join(coreDir, rel), "utf-8");
      if (pat.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("nogo-l0-path: capture code stays LLM-free (no generateText/generateObject)", () => {
    for (const rel of [
      "src/core/conversation/l0-recorder.ts",
      "src/core/hooks/auto-capture.ts",
    ]) {
      const src = readRepo(rel);
      expect(src, `${rel} must stay LLM-free`).not.toMatch(
        /generateText|generateObject/,
      );
    }
  });

  it("write routes are behind the loopback write-gate (4× checkMemoryWriteAuth in server.ts)", () => {
    const server = readRepo("src/gateway/server.ts");
    const calls = server.match(/checkMemoryWriteAuth\(req, res\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(server).toMatch(
      /import \{ checkWriteAuth as isMemoryWriteAuthed \} from "\.\/write-auth\.js"/,
    );
  });

  it("the role prompt forbids POST routes and direct memory writes (child never calls /memory/apply)", () => {
    const prompt = readRepo("src/core/prompts/memory-keeper.md");
    expect(prompt).toContain("Никаких POST-роутов");
    expect(prompt).toMatch(/\/memory\/apply/); // mentioned only as a prohibition target
    expect(prompt).toContain("только GET");
  });

  it("no --no-skills in the spawn module (skills/subagents stay available to the child)", () => {
    // spawnKeeper (with spawnFlags) lives in keeper-run.ts; child-spawn.ts is
    // the env+re-export shim. Check both for the banned literal.
    const run = readRepo("src/gateway/consolidation/keeper-run.ts");
    expect(run.includes('"--no-skills"')).toBe(false);
    expect(run).toContain("spawnFlags"); // flags come from config, not a literal list
    const shim = readRepo("src/gateway/consolidation/child-spawn.ts");
    expect(shim.includes('"--no-skills"')).toBe(false);
  });

  it("env whitelist is explicit — buildChildEnv hard-codes exactly the allowlist (nogo-secrets)", () => {
    const spawn = readRepo("src/gateway/consolidation/child-spawn.ts");
    expect(spawn).toContain("PATH: deps.pathValue");
    expect(spawn).toContain("HOME: deps.home");
    expect(spawn).toContain('[ENV_KEEPER]: "1"');
    expect(spawn).toContain("[ENV_GATEWAY_URL]: deps.gatewayUrl");
    // The builder deliberately copies NOTHING else from process.env — the
    // unit test child-spawn.test.ts asserts the key set exactly.
    expect(spawn).toContain("Deliberately no other keys");
    expect(spawn).toContain("PI_MEMORY_KEEPER_RUN");
  });
});

/** Recursively list *.ts files under a directory (relative paths). */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      out.push(
        ...walkTs(path.join(dir, entry.name)).map((p) => `${entry.name}/${p}`),
      );
    else if (entry.name.endsWith(".ts")) out.push(entry.name);
  }
  return out;
}

// ============================
// tz-01 criteria 7-8 — the contract is the ONLY source of role parameters
// ============================

/** `*.ts` only: consolidation/ also holds `*.bak-*` snapshots of old files. */
function roleSourceFiles(): Array<{ rel: string; src: string }> {
  const consolidationDir = path.join(REPO_ROOT, "src/gateway/consolidation");
  const files = walkTs(consolidationDir)
    .map((f) => `src/gateway/consolidation/${f}`)
    .concat(
      fs
        .readdirSync(path.join(REPO_ROOT, "src/gateway"))
        .filter((f) => f.startsWith("role-") && f.endsWith(".ts"))
        .map((f) => `src/gateway/${f}`),
    )
    .filter((rel) => !rel.endsWith(".test.ts"));
  return files.map((rel) => ({ rel, src: readRepo(rel) }));
}

/** Drop comments and string literals: a doc line or a warning message may
 * NAME the global config; only an actual read counts. */
function codeOnly(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("*")) continue;
    out.push(raw.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""'));
  }
  return out;
}

describe("tz-01 criterion 7 — no global config read on the role path", () => {
  it("no module under consolidation/ or role-*.ts reads config.memory.consolidation/nightRun", () => {
    const offenders: string[] = [];
    for (const { rel, src } of roleSourceFiles()) {
      codeOnly(src).forEach((line, i) => {
        if (
          line.includes("config.memory.consolidation.") ||
          line.includes("config.memory.nightRun.")
        )
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    // Role parameters arrive as a resolved contract (+ the legacy snapshot
    // built at the composition root); the global config is read in
    // src/config.ts and server.ts only.
    expect(offenders).toEqual([]);
  });
});

describe("tz-01 criterion 8 — no name-based dispatch", () => {
  const ROLE_NAMES = ["night-keeper", "memory-keeper", "dedup-daily"];

  it("consolidation modules never branch on a role name", () => {
    const offenders: string[] = [];
    for (const { rel, src } of roleSourceFiles()) {
      if (!rel.startsWith("src/gateway/consolidation/")) continue;
      src.split("\n").forEach((line, i) => {
        if (!ROLE_NAMES.some((n) => line.includes(`"${n}"`))) return;
        // A default role NAME (registration, `?? "memory-keeper"`) is allowed;
        // a role name inside a condition is the dispatch tz-01 removes.
        const isBranch =
          /\bif\s*\(/.test(line) ||
          line.includes("===") ||
          line.includes("!==") ||
          /(^|[^?])\?($|[^?.])/.test(line.replace(/\?\?/g, ""));
        if (isBranch) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the default role name is a registration default, not a branch", () => {
    const orchestrator = readRepo("src/gateway/consolidation/orchestrator.ts");
    expect(orchestrator).toContain('opts.roleName ?? "memory-keeper"');
  });
});

// ============================
// tz-09 criterion 4 — `[a]` no path in apply() around assertOpsSubset + caps
// ============================

describe("tz-09 criterion 4 — apply() has no path around the gate", () => {
  it("runApplyGate is called exactly once in apply(), before every mutation", () => {
    const src = readRepo("src/gateway/apply-executor.ts");
    const lines = codeOnly(src);
    const gateCalls = lines.filter((l) => l.includes("runApplyGate("));
    expect(gateCalls).toHaveLength(1);
    // …and it must be an unconditional STATEMENT. `if (…) runApplyGate(…)`
    // keeps the call count at one while opening a way past the gate, which
    // is exactly the shape criterion 4 forbids.
    expect(gateCalls[0]?.trim().startsWith("runApplyGate(")).toBe(true);

    const idx = (needle: string): number =>
      lines.findIndex((l) => l.includes(needle));
    const gateAt = idx("runApplyGate(");
    // Every mutation entry point must come AFTER the gate line.
    for (const mutation of [
      "applyMerges(",
      "applyRewritesRecords(",
      "applyDeletes(",
      "applyRewrites(",
    ]) {
      const at = idx(mutation);
      expect(at, `${mutation} must appear after the gate`).toBeGreaterThan(
        gateAt,
      );
    }
  });

  it("the gate module is the ONLY caller of assertOpsSubset in the apply path", () => {
    const callers: string[] = [];
    const dir = path.join(REPO_ROOT, "src/gateway/apply-executor");
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const src = fs.readFileSync(path.join(dir, entry), "utf-8");
      // The definition lives in validate.ts; every other mention is a call.
      if (entry === "validate.ts") continue;
      if (codeOnly(src).some((l) => l.includes("assertOpsSubset("))) {
        callers.push(entry);
      }
    }
    expect(callers).toEqual(["gate.ts"]);
  });
});
