#!/usr/bin/env node
/**
 * smoke-recall.mjs — §6 "is vector recall live?" one-click smoke test.
 *
 * Validates a REAL running TDAI Gateway end-to-end against its REAL configured
 * embedding provider (e.g. Alibaba DashScope). It does exactly the manual §6
 * check from docs/tdai_gateway_integration.md, but repeatable and asserted:
 *
 *   1. GET  /health            — gateway up? embedding configured at all?
 *   2. POST /capture           — record a distinctive fact for a throwaway account
 *   3. POST /search/memories   — poll with a PARAPHRASE that shares NO keywords
 *                                with the fact, until an L1 atom is recalled
 *   4. assert strategy         — PASS only if `hybrid`/`embedding` fired (vectors
 *                                actually contributed); `fts`/`none` => FAIL
 *   5. POST /namespace/wipe    — clean up the throwaway account (multi-tenant)
 *
 * Why a paraphrase with no shared tokens: keyword (FTS/BM25) can't bridge it, so
 * a hit can only come from vector similarity. That isolates the embedding path.
 *
 * No build, no deps — needs only Node >= 18 (global fetch). Run against a gateway
 * that is already started with your real .env (DashScope key, TDAI_LLM_*, etc.):
 *
 *   node scripts/smoke-recall.mjs
 *   TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
 *   TDAI_GATEWAY_API_KEY=*** node scripts/smoke-recall.mjs --timeout 120
 *
 * Exit codes: 0 = PASS, 1 = FAIL (vectors not contributing / no recall),
 *             2 = setup error (gateway unreachable, bad config, capture failed).
 *
 * Override the probe text for non-Chinese / domain-specific deployments via env:
 *   SMOKE_FACT_USER, SMOKE_FACT_ASSISTANT, SMOKE_KEYWORD, SMOKE_PARAPHRASE
 * (keep KEYWORD a substring of the fact, and PARAPHRASE sharing no tokens with it).
 */

// ── config ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const BASE = (process.env.TDAI_GATEWAY_URL || flagVal("--url") || "http://127.0.0.1:8420").replace(/\/$/, "");
const API_KEY = process.env.TDAI_GATEWAY_API_KEY || flagVal("--api-key") || "";
const TIMEOUT_MS = Number(flagVal("--timeout") ?? process.env.SMOKE_TIMEOUT_SEC ?? 90) * 1000;
const POLL_MS = Number(flagVal("--poll") ?? 4) * 1000;
const KEEP = hasFlag("--keep") || hasFlag("--no-wipe");

// A unique throwaway account so the test is isolated and cleanly wipeable.
const SESSION =
  flagVal("--session") ||
  process.env.SMOKE_SESSION ||
  `smoke:recall:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;

// Distinctive fact + a paraphrase that shares NO surface tokens with it.
const FACT_USER = process.env.SMOKE_FACT_USER || "我每个周末都会去山里露营和钓鱼，这是我最喜欢的放松方式。";
const FACT_ASSISTANT = process.env.SMOKE_FACT_ASSISTANT || "听起来很惬意，亲近大自然确实能让人充电。";
const KEYWORD = process.env.SMOKE_KEYWORD || "露营"; // appears in the fact → formation probe
const PARAPHRASE = process.env.SMOKE_PARAPHRASE || "户外探险活动"; // no shared tokens, near in meaning

const VECTOR_STRATEGIES = new Set(["hybrid", "embedding"]);

// ── tiny http helper ────────────────────────────────────────────────────────
const headers = { "content-type": "application/json", ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) };

async function req(method, path, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { _raw: text };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const log = (...a) => console.log("[smoke]", ...a);
const fail = (msg) => {
  console.error("\n[smoke] ❌ FAIL —", msg);
  process.exit(1);
};
const setupError = (msg) => {
  console.error("\n[smoke] ⚠️  SETUP ERROR —", msg);
  process.exit(2);
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── flow ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`gateway   : ${BASE}`);
  log(`auth      : ${API_KEY ? "Bearer (set)" : "none"}`);
  log(`session   : ${SESSION}`);
  log(`fact      : "${FACT_USER}"`);
  log(`paraphrase: "${PARAPHRASE}"  (shares no keywords with the fact)`);
  log("");

  // 1. Health + embedding-intent gate -----------------------------------------
  let health;
  try {
    health = await req("GET", "/health");
  } catch (err) {
    setupError(`cannot reach gateway at ${BASE} (${err?.cause?.code || err?.name || err}). Is it running?`);
  }
  if (health.status === 401 || health.status === 403) {
    setupError(`/health returned ${health.status} — unexpected (health should be unauthenticated). Check the URL.`);
  }
  if (health.status !== 200 || health.json.status !== "ok") {
    setupError(`/health not ok: status=${health.status} body=${JSON.stringify(health.json)}`);
  }
  const multiTenant = health.json.multi_tenant === true;
  const emb = health.json.embedding;
  log(`health    : ok  version=${health.json.version}  multi_tenant=${multiTenant}`);
  if (emb) {
    log(`embedding : configured=${emb.configured} provider=${emb.provider} model=${emb.model ?? "?"} dims=${emb.dimensions ?? "?"} recall=${emb.recallStrategy}`);
  } else {
    log(`embedding : (no embedding block in /health — older gateway build)`);
  }
  // Fail fast on the single most common cause, with no waiting.
  if (emb && emb.configured === false) {
    fail(
      `embedding is NOT configured (provider=${emb.provider}). Vector recall cannot work.\n` +
      `         Fix the memory.embedding.* block in tdai-gateway.yaml (DashScope text-embedding-v3, the key),\n` +
      `         set memory.recall.strategy: hybrid, and restart the gateway. (Embedding is yaml-only — there are no TDAI_EMBEDDING_* envs.)`,
    );
  }

  // 2. Capture a distinctive fact ----------------------------------------------
  const cap = await req("POST", "/capture", {
    session_key: SESSION,
    session_id: `smoke-${Date.now()}`,
    user_content: FACT_USER,
    assistant_content: FACT_ASSISTANT,
  });
  if (cap.status !== 200) {
    setupError(`/capture failed: status=${cap.status} body=${JSON.stringify(cap.json)}`);
  }
  log(`capture   : ok  l0_recorded=${cap.json.l0_recorded} scheduler_notified=${cap.json.scheduler_notified}`);
  log("");
  log(`polling /search/memories every ${POLL_MS / 1000}s for up to ${TIMEOUT_MS / 1000}s (waiting for L1 to form)…`);

  // 3. Poll the paraphrase search until a vector hit or timeout -----------------
  const search = (query) => req("POST", "/search/memories", { query, session_key: SESSION, limit: 5 });

  const deadline = Date.now() + TIMEOUT_MS;
  let lastStrategy = "none";
  let lastTotal = 0;
  let sawVector = false;
  let formationConfirmed = false; // keyword probe found the atom at all

  while (Date.now() < deadline) {
    const para = await search(PARAPHRASE);
    if (para.status !== 200) {
      setupError(`/search/memories failed: status=${para.status} body=${JSON.stringify(para.json)}`);
    }
    lastStrategy = para.json.strategy ?? "none";
    lastTotal = para.json.total ?? 0;

    if (lastTotal > 0 && VECTOR_STRATEGIES.has(lastStrategy)) {
      sawVector = true;
      break; // PASS condition met — vectors fired on a no-keyword query
    }

    // Diagnostic-only keyword probe: did L1 form at all yet?
    if (!formationConfirmed) {
      const probe = await search(KEYWORD);
      if (probe.status === 200 && (probe.json.total ?? 0) > 0) formationConfirmed = true;
    }

    const elapsed = Math.round((TIMEOUT_MS - (deadline - Date.now())) / 1000);
    log(`  …${elapsed}s  paraphrase: total=${lastTotal} strategy=${lastStrategy}  | L1 formed=${formationConfirmed}`);
    await delay(POLL_MS);
  }

  // 4. Verdict ------------------------------------------------------------------
  log("");
  const cleanup = async () => {
    if (KEEP) {
      log(`cleanup   : skipped (--keep). Throwaway account left as "${SESSION}".`);
      return;
    }
    if (!multiTenant) {
      log(`cleanup   : single-tenant mode — /namespace/wipe is refused; smoke data stays in the shared store.`);
      log(`            (Run a multi-tenant gateway, or use a disposable dataDir, to auto-clean.)`);
      return;
    }
    const w = await req("POST", "/namespace/wipe", { session_key: SESSION });
    log(w.status === 200 && w.json.wiped ? `cleanup   : wiped throwaway account ✓` : `cleanup   : wipe returned status=${w.status} body=${JSON.stringify(w.json)}`);
  };

  if (sawVector) {
    await cleanup();
    log("");
    log(`✅ PASS — vector recall is LIVE. A no-keyword paraphrase recalled the fact via strategy="${lastStrategy}".`);
    process.exit(0);
  }

  // Failed — distinguish the two root causes for an actionable message.
  await cleanup();
  if (formationConfirmed) {
    fail(
      `L1 formed (the fact is searchable by keyword), but the paraphrase only ever returned ` +
      `total=${lastTotal} strategy="${lastStrategy}" — vectors are NOT contributing.\n` +
      `         => Embedding is enabled but not actually producing hits. Check the DashScope key/endpoint,\n` +
      `            the model/dimensions in memory.embedding.*, and that memory.recall.strategy is hybrid/embedding.\n` +
      `            (Watch the gateway logs for embedding errors during the search.)`,
    );
  } else {
    fail(
      `could not confirm L1 formation within ${TIMEOUT_MS / 1000}s (keyword "${KEYWORD}" never matched, ` +
      `paraphrase strategy="${lastStrategy}").\n` +
      `         => Either extraction is slow/off (check TDAI_LLM_* and the gateway logs for L1 activity),\n` +
      `            or the run needs longer — retry with --timeout 180. The fact may also have been\n` +
      `            extracted with different wording; try SMOKE_KEYWORD/SMOKE_PARAPHRASE overrides.`,
    );
  }
}

main().catch((err) => setupError(err?.stack || String(err)));
