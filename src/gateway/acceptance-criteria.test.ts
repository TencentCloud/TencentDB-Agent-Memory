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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TdaiGateway } from "./server.js";
import { parseConfig } from "../config.js";

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
    fs.mkdirSync(path.join(base, "scene_blocks", "_global"), { recursive: true });
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
    try {
      const res = await fetch(`${baseUrl}/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        dataPath: string;
        consolidation: { enabled: boolean; checkpoint: string; inFlight: boolean };
      };
      // "ok" with a live embedder; scratch boots fail-open as "degraded" —
      // both are serving states, never an error page.
      expect(["ok", "degraded"]).toContain(body.status);
      expect(body.dataPath).toBe(base);
      expect(body.consolidation.checkpoint).toContain("consolidation_checkpoint.json");
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
        consolidation: { checkpoint: string; inFlight: boolean; lastRun: unknown };
      };
      expect(["ok", "degraded"]).toContain(body.status);
      expect(body.dataPath).toBe(base);
      expect(body.consolidation.checkpoint).toContain("consolidation_checkpoint.json");
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
      const authed = await fetch(`${baseUrl}/memory/apply`, {
        method: "POST",
        headers: { "x-memory-token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ diff: {}, manifest: { baseline: {} }, context: { presentedRecordIds: [] } }),
      });
      // Empty diff is valid — proves the write-gate itself works post-restart.
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
    expect(flat).toContain("ТОЛЬКО через POST /memory/apply со стороны гейтвея");
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
        expect(src.includes(pattern), `${rel} must not contain ${pattern}`).toBe(false);
      }
    }
  });

  it("night-run reads schedule/threshold/timezone from config deps (no literals in code)", () => {
    const nightRun = readRepo("src/gateway/consolidation/night-run.ts");
    expect(nightRun).toMatch(/schedule:\s*string/); // injected, not built-in
    expect(nightRun).toMatch(/threshold:\s*number/);
    expect(nightRun).toMatch(/timezone:\s*string/);
    expect(nightRun).not.toMatch(/\?\?\s*"06:00"/);
    expect(nightRun).not.toMatch(/=\s*"06:00"/);
  });

  it("the documented defaults live in src/config.ts (single source of truth)", () => {
    const cfg = readRepo("src/config.ts");
    expect(cfg).toContain('?? "opencode-go/deepseek-v4-flash"');
    expect(cfg).toContain('?? "06:00"');
    expect(cfg).toMatch(/threshold:\s*num\(nightRunGroup, "threshold"\) \?\? 50/);
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
    expect(cfg.recall.typeWeights).toEqual({ instruction: 1, persona: 1, episodic: 1 });
  });
});

// ============================
// Criterion 20 — negative INVARIANT static checks
// ============================

describe("criterion 20 — negative INVARIANT checks (static)", () => {
  it("nogo-l1-prompt: L1 prompt 014808 (判据 + exclusion) and MAX_CONTENT_CHARS=600 stay in place", () => {
    const l1 = readRepo("src/core/prompts/l1-extraction.ts");
    expect(l1).toContain("判据");
    expect(l1).toContain("不应该提取的内容");
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
    for (const rel of ["src/core/conversation/l0-recorder.ts", "src/core/hooks/auto-capture.ts"]) {
      const src = readRepo(rel);
      expect(src, `${rel} must stay LLM-free`).not.toMatch(/generateText|generateObject/);
    }
  });

  it("write routes are behind the loopback write-gate (4× checkMemoryWriteAuth in server.ts)", () => {
    const server = readRepo("src/gateway/server.ts");
    const calls = server.match(/checkMemoryWriteAuth\(req, res\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(server).toMatch(/import \{ checkWriteAuth as isMemoryWriteAuthed \} from "\.\/write-auth\.js"/);
  });

  it("the role prompt forbids POST routes and direct memory writes (child never calls /memory/apply)", () => {
    const prompt = readRepo("src/core/prompts/memory-keeper.md");
    expect(prompt).toContain("Никаких POST-роутов");
    expect(prompt).toMatch(/\/memory\/apply/); // mentioned only as a prohibition target
    expect(prompt).toContain("только GET");
  });

  it("no --no-skills in the spawn module (skills/subagents stay available to the child)", () => {
    const spawn = readRepo("src/gateway/consolidation/child-spawn.ts");
    expect(spawn.includes('"--no-skills"')).toBe(false);
    expect(spawn).toContain("spawnFlags"); // flags come from config, not a literal list
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
    if (entry.isDirectory()) out.push(...walkTs(path.join(dir, entry.name)).map((p) => `${entry.name}/${p}`));
    else if (entry.name.endsWith(".ts")) out.push(entry.name);
  }
  return out;
}
