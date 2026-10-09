/**
 * import-psydt — bulk-import the PsyDTCorpus multi-turn counselling dialogues
 * into the multi-tenant TDAI store, one account per conversation.
 *
 * Each corpus item is `{ id, normalizedTag, messages: [{role, content}] }`.
 * We map:
 *   - account / username  →  `User{id}`        (e.g. id 2993 → "User2993")
 *   - session_key         →  `psydt:User{id}`  (namespaced, like `ai4all:alice`)
 *   - rounds              →  the user/assistant turns, paired; the `system`
 *                            REBT-therapist prompt is dropped (it is a prompt,
 *                            not the user's dialogue, and would pollute memory).
 *
 * Why a dedicated script and NOT the gateway `/seed` endpoint:
 *   `/seed` writes ALL sessions into a single `baseDir/seed-<ts>/` snapshot dir,
 *   so its output never lands in the per-account dirs that multi-tenant recall
 *   and the dev-console read. Here we call `executeSeed` once per account with
 *   `outputDir = baseDir/safeAccountDir(session_key)` — the EXACT directory the
 *   gateway's per-account core and the inspector resolve — so each imported user
 *   shows up as its own pyramid (L0→L1→L2→L3, with DashScope vectors).
 *
 * Config (LLM + embedding + baseDir) is loaded with the same `loadGatewayConfig`
 * the gateway uses, so this imports against the identical DeepSeek + DashScope
 * setup. Run it while the gateway is up — these are fresh keys, so no live core
 * holds their dirs.
 *
 * Usage:
 *   node --env-file=.env --import tsx scripts/import-psydt.ts [--input <file>]
 *        [--limit N] [--only User2993[,User1977,...]] [--force]
 *
 *   --limit N    import only the first N conversations (cheap smoke test)
 *   --only ...   import only the listed users (by "User<id>" or bare id)
 *   --force      re-import: delete an account's existing dir before seeding
 *                (default: skip accounts that already have L0 on disk)
 */

import fs from "node:fs";
import path from "node:path";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { safeAccountDir } from "../src/gateway/core-registry.js";
import { validateAndNormalizeRaw } from "../src/core/seed/input.js";
import { executeSeed } from "../src/core/seed/seed-runtime.js";
import type { Logger } from "../src/core/types.js";

const DEFAULT_INPUT =
  "/Users/suchong/Data/PsyDTCorpus/PsyDTCorpus_train_mulit_turn_packing_longest20.json";

interface RawMsg { role: string; content: string }
interface CorpusItem { id: number | string; normalizedTag?: string; messages: RawMsg[] }

// ── tiny arg parser ──────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const out: { input: string; limit?: number; only?: Set<string>; force: boolean } = {
    input: DEFAULT_INPUT,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") out.input = argv[++i]!;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--force") out.force = true;
    else if (a === "--only") {
      out.only = new Set(
        (argv[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => (s.startsWith("User") ? s : `User${s}`)),
      );
    }
  }
  return out;
}

// ── console logger (PipelineLogger = Logger) ─────────────────────────────
const logger: Logger = {
  debug: () => {},                              // seed is chatty at debug — mute
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

/**
 * Turn a flat corpus message list into seed "conversations" (a 2-D array of
 * rounds). Drops `system`, drops empty content, and starts a new round at each
 * `user` turn so each round is `[user, assistant]` (the corpus strictly
 * alternates, but the boundary rule is robust to stray ordering).
 */
function toRounds(messages: RawMsg[]): RawMsg[][] {
  const dialog = messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.content && m.content.trim() !== "",
  );
  const rounds: RawMsg[][] = [];
  let cur: RawMsg[] = [];
  for (const m of dialog) {
    if (m.role === "user" && cur.length > 0) {
      rounds.push(cur);
      cur = [];
    }
    cur.push({ role: m.role, content: m.content });
  }
  if (cur.length) rounds.push(cur);
  return rounds;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadGatewayConfig();

  if (!cfg.data.multiTenant) {
    console.error("Refusing to import: gateway is in single-tenant mode (set TDAI_MULTI_TENANT=true).");
    process.exit(1);
  }
  if (!cfg.llm.apiKey) {
    console.error("No LLM api key (TDAI_LLM_API_KEY) — L1/L2/L3 cannot build. Aborting.");
    process.exit(1);
  }

  // Mirror the gateway's /seed config assembly: memory config + injected llm.
  const pluginConfig: Record<string, unknown> = {
    ...(cfg.memory as unknown as Record<string, unknown>),
    llm: {
      enabled: true,
      baseUrl: cfg.llm.baseUrl,
      apiKey: cfg.llm.apiKey,
      model: cfg.llm.model,
      maxTokens: cfg.llm.maxTokens,
      timeoutMs: cfg.llm.timeoutMs,
      disableThinking: cfg.llm.disableThinking,
    },
  };
  const embeddingOn = (cfg.memory as any)?.embedding?.enabled === true;

  const raw = JSON.parse(fs.readFileSync(args.input, "utf8")) as CorpusItem[];
  let items = Array.isArray(raw) ? raw : [];
  if (args.only) items = items.filter((it) => args.only!.has(`User${it.id}`));
  if (args.limit != null) items = items.slice(0, args.limit);

  console.log(
    `\n=== PsyDT import ===\n` +
      `  input      : ${args.input}\n` +
      `  baseDir    : ${cfg.data.baseDir}\n` +
      `  llm        : ${cfg.llm.model} @ ${cfg.llm.baseUrl}\n` +
      `  embedding  : ${embeddingOn ? "ON (vectors)" : "OFF (keyword only)"}\n` +
      `  importing  : ${items.length} conversation(s)\n` +
      `  force      : ${args.force}\n`,
  );

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const username = `User${item.id}`;
    const sessionKey = `psydt:${username}`;
    const outputDir = path.join(cfg.data.baseDir, safeAccountDir(sessionKey));
    const rounds = toRounds(item.messages);
    const tag = item.normalizedTag ?? "";
    const header = `[${i + 1}/${items.length}] ${username} (${tag}, ${rounds.length} rounds)`;

    if (rounds.length === 0) {
      console.warn(`${header} — no dialogue rounds, skipping`);
      skipped++;
      continue;
    }

    // Idempotency: skip an account that already has L0 unless --force.
    const dbPath = path.join(outputDir, "vectors.db");
    if (fs.existsSync(dbPath) && !args.force) {
      console.log(`${header} — already imported (dir exists), skipping. Use --force to re-import.`);
      skipped++;
      continue;
    }
    if (args.force && fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }

    const input = validateAndNormalizeRaw([{ sessionKey, conversations: rounds }], {
      sessionKey,
      autoFillTimestamps: true,
    });

    console.log(`\n${header} → ${outputDir}`);
    try {
      const t0 = Date.now();
      const summary = await executeSeed(input, {
        outputDir,
        openclawConfig: {},
        pluginConfig,
        logger,
      });
      console.log(
        `${header} ✓ l0=${summary.l0RecordedCount} rounds=${summary.roundsProcessed} ` +
          `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      ok++;
    } catch (err) {
      console.error(`${header} ✗ ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\n=== done: ${ok} imported, ${skipped} skipped, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
