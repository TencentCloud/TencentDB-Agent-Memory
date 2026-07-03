#!/usr/bin/env npx tsx
/**
 * seed-v2 — -- v2 API ------- memory-tencentdb gateway。
 *
 * -- `src/cli/commands/seed.ts`（v1，import -- runtime --）--：
 *   - - HTTP ---，- import -- plugin ----
 *   - -- `/v2/conversation/add` - L0 + - gateway ---- L1/L2/L3
 *   - ---- `/v2/pipeline/status` - `busy` -----
 *   - ---- standalone，---- service --（-----）
 *
 * ----（--- `seed-runtime.executeSeed`）:
 *   - per-round -- conversation/add -----
 *   - - N -（--every-n / SEED_EVERY_N）--- busy=false（stable polls）
 *   - -- session ------
 *   - ------ final drain
 *
 * @example
 *   # - npm script --
 *   npm run seed-v2 -- --input ./fixtures/minimal.json
 *
 *   # --- tsx
 *   npx tsx scripts/seed-v2/seed-v2.ts --input fixture.json --endpoint http://127.0.0.1:18420
 *
 *   # ----
 *   --input <file>            --，fixture JSON --
 *   --endpoint <url>          gateway --（-- http://127.0.0.1:18420）
 *   --service-id <id>         x-tdai-service-id（-- default）
 *   --api-key <key>           Bearer key（-- standalone-e2e）
 *   --every-n <n>             - N - wait -- busy=false（-- 5）
 *   --max-wait-ms <ms>        -- wait ----（-- 600000=10 --）
 *   --no-final-wait           -------- cascade，----
 *   --dry-run                 ----------
 *   --quiet                   ----
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import dayjs from "dayjs";

import { validateAndNormalizeRaw, fillTimestamps, SeedValidationError } from "./input-validate.js";
import type { NormalizedInput } from "./input-types.js";

// ============================
// Logger (timestamped console wrappers)
// ============================

/**
 * Full ISO 8601 local-timezone timestamp, e.g. "2026-05-21T15:03:00.123+08:00".
 * Aligned with the standalone gateway's console logger so seed-v2 lines and
 * gateway lines can be merged/sorted by timestamp during incident review.
 */
function ts(): string {
  return dayjs().format("YYYY-MM-DDTHH:mm:ss.SSSZ");
}

const log  = (msg: string): void => { console.log(`${ts()} ${msg}`); };
const warn = (msg: string): void => { console.warn(`${ts()} ${msg}`); };
const err  = (msg: string): void => { console.error(`${ts()} ${msg}`); };

// Truncate long content to a single-line preview safe for logs.
function preview(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}...`;
}

// ============================
// CLI args + env fallback
// ============================

interface CliOptions {
  input: string;
  endpoint: string;
  apiKey: string;
  serviceId: string;
  everyN: number;
  pollMs: number;
  stableRounds: number;
  maxWaitMs: number;          // per every-N / per-session-tail wait timeout (L1 only)
  finalMaxWaitMs: number;     // final all-layer drain wait timeout (L1+L2+L3)
  finalWait: boolean;
  dryRun: boolean;
  quiet: boolean;
  // Input validation / normalization options (parity with old seed CLI)
  sessionKey?: string;          // fallback for sessions missing sessionKey
  strictRoundRole: boolean;      // each round must have user + assistant
  autoFillTimestamps: boolean;   // when all-missing, fill globally-monotonic ts
}

function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      input:           { type: "string",  short: "i" },
      endpoint:        { type: "string",  short: "e" },
      "api-key":       { type: "string" },
      "service-id":    { type: "string",  short: "s" },
      "every-n":       { type: "string",  short: "n" },
      "poll-ms":       { type: "string" },
      "stable-rounds": { type: "string" },
      "max-wait-ms":   { type: "string" },
      "final-max-wait-ms": { type: "string" },
      "no-final-wait": { type: "boolean" },
      "dry-run":       { type: "boolean" },
      "session-key":   { type: "string" },
      "strict-round-role":         { type: "boolean" },
      "no-auto-fill-timestamps":   { type: "boolean" },
      quiet:           { type: "boolean", short: "q" },
      help:            { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const input = (values.input as string | undefined) ?? process.argv[2];
  if (!input) {
    console.error("error: --input <fixture.json> is required");
    printHelp();
    process.exit(2);
  }

  const intOpt = (key: string, env: string, def: number): number => {
    const raw = (values[key] as string | undefined) ?? process.env[env];
    if (raw == null || raw === "") return def;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : def;
  };

  return {
    input,
    endpoint:     (values.endpoint     as string) ?? process.env.SEED_ENDPOINT     ?? "http://127.0.0.1:18420",
    apiKey:       (values["api-key"]   as string) ?? process.env.SEED_API_KEY      ?? "standalone-e2e",
    serviceId:    (values["service-id"] as string) ?? process.env.SEED_SERVICE_ID  ?? "default",
    everyN:       intOpt("every-n",       "SEED_EVERY_N",       5),
    pollMs:       intOpt("poll-ms",       "SEED_POLL_MS",       500),
    stableRounds: intOpt("stable-rounds", "SEED_STABLE_ROUNDS", 2),
    maxWaitMs:    intOpt("max-wait-ms",   "SEED_MAX_WAIT_MS",   180_000),
    finalMaxWaitMs: intOpt("final-max-wait-ms", "SEED_FINAL_MAX_WAIT_MS", 600_000),
    finalWait:    !values["no-final-wait"],
    dryRun:       Boolean(values["dry-run"]),
    quiet:        Boolean(values.quiet) || process.env.SEED_VERBOSE === "0",
    sessionKey:           (values["session-key"] as string | undefined) ?? process.env.SEED_FALLBACK_SESSION_KEY,
    strictRoundRole:      Boolean(values["strict-round-role"])         || process.env.SEED_STRICT_ROUND_ROLE === "1",
    autoFillTimestamps:   !values["no-auto-fill-timestamps"]           && process.env.SEED_AUTO_FILL_TIMESTAMPS !== "0",
  };
}

function printHelp(): void {
  console.log(`
seed-v2 — feed historical conversations into memory-tencentdb via v2 API

Usage:
  seed-v2 --input <fixture.json> [options]

Required:
  -i, --input <file>           Fixture JSON file (Format A: { sessions: [...] })

Options:
  -e, --endpoint <url>         Gateway URL (default: http://127.0.0.1:18420)
      --api-key <key>          Bearer key (default: standalone-e2e)
  -s, --service-id <id>        x-tdai-service-id (default: default)
  -n, --every-n <n>            Wait for busy=false every N rounds per session (default: 5)
      --poll-ms <ms>           Status poll interval (default: 500)
      --stable-rounds <n>      Consecutive idle polls before considered stable (default: 2)
      --max-wait-ms <ms>       Per-batch wait timeout, L1 only (default: 180000 = 3 min)
      --final-max-wait-ms <ms> Final drain wait timeout, ALL layers L1+L2+L3 (default: 600000 = 10 min)
      --no-final-wait          Skip final cascade drain wait
      --dry-run                Print plan, no requests
      --session-key <key>      Fallback sessionKey for sessions missing one
      --strict-round-role      Each round must contain user + assistant
      --no-auto-fill-timestamps  Don't auto-fill missing timestamps (will error if all missing)
  -q, --quiet                  Quiet mode (env SEED_VERBOSE=0)
  -h, --help                   Show this help

Fixture JSON (Format A):
  {
    "sessions": [
      {
        "sessionKey": "user-001",
        "sessionId": "user-001",
        "conversations": [
          [
            { "role": "user",      "content": "..." },
            { "role": "assistant", "content": "..." }
          ]
        ]
      }
    ]
  }

Exit codes:
  0  success
  1  seed or wait failed
  2  fixture / config error
`.trim());
}

// ============================
// HTTP helper
// ============================

interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data?: T;
}

interface ApiCallResult<T = unknown> {
  body: ApiResponse<T>;
  httpStatus: number;
  durationMs: number;
}

class SeedClient {
  private callSeq = 0;
  constructor(private opts: CliOptions) {}

  async post<T = unknown>(path: string, body: unknown): Promise<ApiCallResult<T>> {
    this.callSeq++;
    const url = `${this.opts.endpoint}/v2/${path}`;
    const startedAt = Date.now();
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.opts.apiKey}`,
        "x-tdai-service-id": this.opts.serviceId,
      },
      body: JSON.stringify(body),
    });
    const durationMs = Date.now() - startedAt;
    const text = await resp.text();
    let parsed: ApiResponse<T>;
    try {
      parsed = JSON.parse(text) as ApiResponse<T>;
    } catch {
      throw new Error(`non-JSON response from /v2/${path}: ${resp.status} ${text.slice(0, 200)}`);
    }
    return { body: parsed, httpStatus: resp.status, durationMs };
  }
}

// ============================
// Fixture loading + validation (delegates to input-validate.ts)
// ============================

/**
 * Load fixture from disk → parse JSON → validate → normalize. Returns the
 * NormalizedInput shape used downstream (sessions[].rounds[].messages[]),
 * with timestamps either preserved, mixed (rejected), or auto-filled to
 * globally-monotonic epoch ms (parity with v1 fillTimestamps).
 *
 * On validation failure throws SeedValidationError; caller should print and exit 2.
 */
function loadAndValidate(opts: CliOptions): NormalizedInput {
  const abs = resolvePath(opts.input);
  if (!existsSync(abs)) {
    throw new SeedValidationError([{ stage: "file", message: `Fixture not found: ${abs}` }]);
  }
  const text = readFileSync(abs, "utf8").trim();
  if (!text) {
    throw new SeedValidationError([{ stage: "file", message: `Fixture is empty: ${abs}` }]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SeedValidationError([{
      stage: "file",
      message: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    }]);
  }
  return validateAndNormalizeRaw(raw, {
    sessionKey: opts.sessionKey,
    strictRoundRole: opts.strictRoundRole,
    autoFillTimestamps: opts.autoFillTimestamps,
  });
}

// ============================
// Status polling
// ============================

interface LayerStatus {
  queued: number;
  running: number;
  queued_sessions: string[];
  running_sessions: string[];
  idle: boolean;
}

interface StatusData {
  l1: LayerStatus;
  l2: LayerStatus;
  l3: LayerStatus;
}

async function pollStatus(client: SeedClient): Promise<StatusData> {
  const r = await client.post<StatusData>("pipeline/status", {});
  if (r.body.code !== 0 || !r.body.data) {
    throw new Error(`/v2/pipeline/status failed: HTTP ${r.httpStatus} code=${r.body.code} msg=${r.body.message}`);
  }
  return r.body.data;
}

/**
 * Wait until the requested layers are idle for `stableRounds` consecutive polls.
 *
 * @param waitMode "l1"  → only wait for L1 to drain (mid-batch / per-session);
 *                        L2/L3 cascade may still run in background.
 *                "all" → wait for L1+L2+L3 all idle (final drain after all
 *                        rounds dispatched).
 *
 * On timeout: log a `[wait] done reason=timeout` line and return (do not
 * throw). Data is already on disk and the gateway keeps cooking; callers
 * decide whether the next batch can proceed.
 *
 * Logging:
 *   - `[wait] enter` once at the start (label, mode, budget).
 *   - `[poll]` per status snapshot, throttled: first poll, OR queue/running
 *     signature changed, OR 5s heartbeat. Long stable waits stay quiet,
 *     stalls keep showing progress.
 *   - `[wait] done` once at exit with reason=stable|timeout, elapsed, polls.
 */
async function waitForBusyFalse(
  client: SeedClient,
  opts: CliOptions,
  label: string,
  waitMode: "l1" | "all",
  maxWaitMs: number,
): Promise<void> {
  const startTime = Date.now();
  let consecutiveIdle = 0;
  let lastSnapshot: StatusData | null = null;
  let lastLogAtMs = 0;
  let pollCount = 0;
  const HEARTBEAT_INTERVAL_MS = 5000;

  log(`[seed-v2] [wait] enter label="${label}" mode=${waitMode} maxWaitMs=${maxWaitMs} stableRounds=${opts.stableRounds} pollMs=${opts.pollMs}`);

  // Format a compact one-line snapshot for logging.
  const fmt = (s: StatusData): string => {
    const layer = (name: string, l: LayerStatus) => {
      const extras: string[] = [];
      if (l.running_sessions.length > 0) extras.push(`running=${JSON.stringify(l.running_sessions)}`);
      if (l.queued_sessions.length > 0)  extras.push(`queued=${JSON.stringify(l.queued_sessions)}`);
      const tail = extras.length > 0 ? ` ${extras.join(" ")}` : "";
      return `${name}(q=${l.queued} r=${l.running} idle=${l.idle}${tail})`;
    };
    return [layer("L1", s.l1), layer("L2", s.l2), layer("L3", s.l3)].join(" ");
  };

  // Stable signature for change-detection (only fields that matter for idle).
  const sig = (s: StatusData): string =>
    `${s.l1.queued}/${s.l1.running}|${s.l2.queued}/${s.l2.running}|${s.l3.queued}/${s.l3.running}`;
  let lastSig = "";

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > maxWaitMs) {
      const last = lastSnapshot ? fmt(lastSnapshot) : "no-snapshot";
      warn(
        `[seed-v2] [wait] done label="${label}" mode=${waitMode} elapsed=${(elapsed / 1000).toFixed(1)}s ` +
        `polls=${pollCount} reason=timeout last=${last}`,
      );
      return;
    }

    const s = await pollStatus(client);
    pollCount++;
    lastSnapshot = s;
    const isIdle = waitMode === "l1"
      ? s.l1.idle
      : (s.l1.idle && s.l2.idle && s.l3.idle);

    if (isIdle) consecutiveIdle++;
    else consecutiveIdle = 0;

    // Decide whether to log this poll.
    const now = Date.now();
    const currentSig = sig(s);
    const changed = currentSig !== lastSig;
    const heartbeat = now - lastLogAtMs >= HEARTBEAT_INTERVAL_MS;
    const isFirstPoll = lastLogAtMs === 0;
    const willBeStable = isIdle && consecutiveIdle >= opts.stableRounds;

    if (!opts.quiet && (isFirstPoll || changed || heartbeat || willBeStable)) {
      const mark = isIdle ? "idle" : "busy";
      const stable = willBeStable ? " ✓ STABLE" : "";
      log(
        `[seed-v2] [poll] ${label} t+${(elapsed / 1000).toFixed(1)}s ${mark} ${fmt(s)} ` +
        `consecutiveIdle=${consecutiveIdle}${stable}`,
      );
      lastLogAtMs = now;
      lastSig = currentSig;
    }

    if (willBeStable) {
      log(
        `[seed-v2] [wait] done label="${label}" mode=${waitMode} elapsed=${(elapsed / 1000).toFixed(1)}s ` +
        `polls=${pollCount} reason=stable`,
      );
      return;
    }

    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

// ============================
// Conversation/add per round
// ============================

interface AddRoundContext {
  sessionIndex: number;       // 1-based among non-empty sessions
  totalSessions: number;
  sessionKey: string;
  sessionId: string;
  roundIndex: number;         // 1-based within this session
  totalRoundsInSession: number;
  cumRounds: number;          // 1-based across whole fixture
  totalRounds: number;
  cumMessagesAfter: number;   // includes this round (post-success)
  totalMessages: number;
}

async function addRound(
  client: SeedClient,
  ctx: AddRoundContext,
  messages: { role: string; content: string; timestamp: number }[],
  quiet: boolean,
): Promise<number> {
  // After validateAndNormalizeRaw + fillTimestamps, every message has a positive
  // epoch-ms `timestamp` (or 0 if user explicitly opted out via
  // --no-auto-fill-timestamps). v2 conversation/add schema requires ISO 8601 string.
  const payload = messages.map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: new Date(m.timestamp || Date.now()).toISOString(),
  }));

  const roles = payload.map((p) => p.role).join(",");
  const firstTs = payload[0]?.timestamp ?? "n/a";
  const lastTs = payload[payload.length - 1]?.timestamp ?? "n/a";

  if (!quiet) {
    log(
      `[seed-v2] [post] session ${ctx.sessionIndex}/${ctx.totalSessions} round ${ctx.roundIndex}/${ctx.totalRoundsInSession} ` +
      `(${ctx.sessionKey}) → POST /v2/conversation/add session_id="${ctx.sessionId}" ` +
      `msgs=${payload.length} roles=[${roles}] firstTs=${firstTs} lastTs=${lastTs}`,
    );
    for (let i = 0; i < payload.length; i++) {
      const m = payload[i]!;
      log(`[seed-v2] [post]   ${m.role}[${i}]: "${preview(m.content)}"`);
    }
  }

  const r = await client.post<{ accepted_ids: string[]; total_count: number }>("conversation/add", {
    session_id: ctx.sessionId,
    messages: payload,
  });

  const ok = r.body.code === 0 && r.body.data;
  if (!ok) {
    err(
      `[seed-v2] [post] session ${ctx.sessionIndex}/${ctx.totalSessions} round ${ctx.roundIndex}/${ctx.totalRoundsInSession} ` +
      `(${ctx.sessionKey}) ✗ HTTP ${r.httpStatus} code=${r.body.code} msg="${r.body.message}" in ${r.durationMs}ms`,
    );
    throw new Error(`/v2/conversation/add failed for ${ctx.sessionId}: HTTP ${r.httpStatus} code=${r.body.code} msg=${r.body.message}`);
  }

  const accepted = r.body.data!.accepted_ids.length;
  if (!quiet) {
    log(
      `[seed-v2] [post] session ${ctx.sessionIndex}/${ctx.totalSessions} round ${ctx.roundIndex}/${ctx.totalRoundsInSession} ` +
      `(${ctx.sessionKey}) ✓ HTTP ${r.httpStatus} code=0 accepted=${accepted} in ${r.durationMs}ms ` +
      `(cum: rounds=${ctx.cumRounds}/${ctx.totalRounds} msgs=${ctx.cumMessagesAfter}/${ctx.totalMessages})`,
    );
  }
  return accepted;
}

// ============================
// Main
// ============================

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const client = new SeedClient(opts);

  log(
    `[seed-v2] endpoint=${opts.endpoint} serviceId=${opts.serviceId} apiKey=${opts.apiKey ? "***" : "(none)"}`,
  );
  log(
    `[seed-v2] cadence: everyN=${opts.everyN} stableRounds=${opts.stableRounds} pollMs=${opts.pollMs} ` +
    `maxWaitMs=${opts.maxWaitMs}(L1-only) finalMaxWaitMs=${opts.finalMaxWaitMs}(all-layers) finalWait=${opts.finalWait}`,
  );

  // Load + validate + normalize fixture (Layer 2-6 of v1 seed: format detect /
  // session+round+message validation / timestamp consistency check / auto-fill).
  let normalized: NormalizedInput;
  try {
    normalized = loadAndValidate(opts);
  } catch (e) {
    if (e instanceof SeedValidationError) {
      err(`[seed-v2] ${e.message}`);
    } else {
      err(`[seed-v2] fixture load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(2);
  }
  const sessions = normalized.sessions;
  const { totalRounds, totalMessages, hasTimestamps } = normalized;
  log(
    `[seed-v2] fixture=${opts.input} sessions=${sessions.length} rounds=${totalRounds} ` +
    `messages=${totalMessages} hasTimestamps=${hasTimestamps}` +
    (!hasTimestamps && opts.autoFillTimestamps ? " (auto-filled)" : "") +
    ` autoFill=${opts.autoFillTimestamps} strictRoundRole=${opts.strictRoundRole}`,
  );

  // Session manifest preview (first 3 + count).
  const previewSessions = sessions.slice(0, 3)
    .map((s) => `${s.sessionKey}(${s.rounds.length}r)`).join(" ");
  const moreSessions = sessions.length > 3 ? ` ... (+${sessions.length - 3} more)` : "";
  log(`[seed-v2] sessions: ${previewSessions}${moreSessions}`);

  if (opts.dryRun) {
    log("[seed-v2] DRY RUN — exiting without making any requests");
    for (const s of sessions) {
      log(`[seed-v2]   would add: sessionKey=${s.sessionKey} sessionId=${s.sessionId} rounds=${s.rounds.length}`);
    }
    process.exit(0);
  }

  // Pre-flight: status-- must respond
  let preflight: StatusData;
  try {
    preflight = await pollStatus(client);
  } catch (e) {
    err(`[seed-v2] pre-flight /v2/pipeline/status failed: ${(e as Error).message}`);
    err(`[seed-v2]   gateway up at ${opts.endpoint}? deployMode=standalone? stateBackend configured?`);
    process.exit(2);
  }
  log(
    `[seed-v2] pre-flight ok l1.idle=${preflight.l1.idle} ` +
    `(l1 q=${preflight.l1.queued} r=${preflight.l1.running}, ` +
    `l2 q=${preflight.l2.queued} r=${preflight.l2.running}, ` +
    `l3 q=${preflight.l3.queued} r=${preflight.l3.running})`,
  );

  // Per-session, per-round seeding (timestamps now come from normalized input,
  // not synthesized per-call — global monotonic ordering already guaranteed
  // by validateAndNormalizeRaw + fillTimestamps).
  const startMs = Date.now();
  let roundsDone = 0;
  let messagesDone = 0;

  for (let si = 0; si < sessions.length; si++) {
    const session = sessions[si]!;
    const sessionKey = session.sessionKey;
    const sessionId = session.sessionId; // always present after normalization

    if (session.rounds.length === 0) {
      warn(`[seed-v2] session ${si + 1}/${sessions.length} key="${sessionKey}" has no rounds, skipping`);
      continue;
    }

    const sessionStartMs = Date.now();
    let sessionMsgs = 0;
    log(
      `[seed-v2] session ${si + 1}/${sessions.length} START key="${sessionKey}" id="${sessionId}" ` +
      `rounds=${session.rounds.length}`,
    );

    for (let ri = 0; ri < session.rounds.length; ri++) {
      const round = session.rounds[ri]!;
      if (round.messages.length === 0) continue;

      const accepted = await addRound(
        client,
        {
          sessionIndex: si + 1,
          totalSessions: sessions.length,
          sessionKey,
          sessionId,
          roundIndex: ri + 1,
          totalRoundsInSession: session.rounds.length,
          cumRounds: roundsDone + 1,
          totalRounds,
          cumMessagesAfter: messagesDone + round.messages.length,
          totalMessages,
        },
        round.messages,
        opts.quiet,
      );
      roundsDone++;
      messagesDone += accepted;
      sessionMsgs += accepted;

      // Old seed-runtime parity: every N rounds in this session, wait for L1 idle.
      const roundInSession = ri + 1;
      if (roundInSession % opts.everyN === 0) {
        await waitForBusyFalse(client, opts, `every-${opts.everyN}@${sessionKey}#${roundInSession}`, "l1", opts.maxWaitMs);
      }
    }

    // Per-session tail wait (matches old seed-runtime per-session waitForL1Idle).
    await waitForBusyFalse(client, opts, `session-tail@${sessionKey}`, "l1", opts.maxWaitMs);

    const sessionDur = (Date.now() - sessionStartMs) / 1000;
    log(
      `[seed-v2] session ${si + 1}/${sessions.length} END   key="${sessionKey}" ` +
      `rounds=${session.rounds.length} msgs=${sessionMsgs} duration=${sessionDur.toFixed(1)}s`,
    );
  }

  // Final wait: drain any cascade L2/L3 work (best-effort).
  if (opts.finalWait) {
    log(
      `[seed-v2] all rounds dispatched, final drain — waiting for L1+L2+L3 all idle ` +
      `(max ${(opts.finalMaxWaitMs / 1000).toFixed(0)}s)...`,
    );
    await waitForBusyFalse(client, opts, "final", "all", opts.finalMaxWaitMs);
  } else {
    log(`[seed-v2] all rounds dispatched, --no-final-wait set, exiting immediately`);
  }

  const durationMs = Date.now() - startMs;
  log(
    `[seed-v2] done sessions=${sessions.length} rounds=${roundsDone}/${totalRounds} ` +
    `msgs=${messagesDone}/${totalMessages} duration=${(durationMs / 1000).toFixed(1)}s`,
  );

  // Final status snapshot for downstream verification.
  const final = await pollStatus(client);
  const allIdle = final.l1.idle && final.l2.idle && final.l3.idle;
  log(
    `[seed-v2] final status: l1.idle=${final.l1.idle} l2.idle=${final.l2.idle} l3.idle=${final.l3.idle} ` +
    `(l1 q=${final.l1.queued} r=${final.l1.running}, ` +
    `l2 q=${final.l2.queued} r=${final.l2.running}, ` +
    `l3 q=${final.l3.queued} r=${final.l3.running})` +
    (allIdle ? " ✓ all clean" : " ⚠ residual work — gateway will keep cooking after exit"),
  );
}

main().catch((e) => {
  err(`[seed-v2] FATAL: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
