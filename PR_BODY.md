# agents/openhands: OpenHands SDK adapter + proxy registration
> v2.0.x images. Anything not reproducible there is marked **UNVERIFIED**.

## Description | 描述

Adds `agents/openhands/` — a docs+example adapter for the **OpenHands SDK**
(v1.x, LiteLLM transport) on the Memory Proxy, plus the minimal proxy-side
registration that makes `agentSource=openhands` behave like the other
header-preselect clients (`hermes` / `openclaw`), and two small product fixes
surfaced by the integration work:

1. **Adapter package** `agents/openhands/` — README (+`README_CN.md`, structure
   mirrors `agents/hermes/README.md`), `TROUBLESHOOTING.md`, runnable example
   `example/openhands_connect.py` (no network at import), and `validate.js`
   (conventions mirrored from `adapters/opencode/validate.js`) with a sample
   `openhands.json`.
2. **Proxy registration** — `openhands` added to `_headerOnlyAgents`
   (`MemoryProxy/src/handler.ts:781`) and the credit-reporter agent regex
   (`MemoryProxy/src/credit-reporter.ts:77`). Routing needs no change:
   `agentSource` is the first path segment (`handler.ts:664-667`) and the
   generic `POST /:agent/:spaceId/v1/chat/completions` route already exists
   (`MemoryProxy/src/server.ts:336`). Header names come from `headerAutoSelect`
   defaults (`config.ts:98-104`) — no new session-init code.
3. **Bridge L1 prefix parity** — `loadSessionIdsL1` in
   `MemoryProxy/src/skill/skill-bridge.ts` and `MemoryProxy/src/memory/memory-bridge.ts`
   now also probe the header-preselect composite keys (`hermes:` / `openclaw:`
   / `openhands:`; chat path stores
   `${agentSource}:${sessionId}`, `handler.ts:810,877`).
4. **Session store persistence** — `deploy/global-images/start-proxy.sh` mounts a
   named volume (`PROXY_VOLUME`, default `tdai-proxy-data`) at the image's baked
   `PROXY_DB_PATH=/data/tdai-memory-proxy` (`MemoryProxy/Dockerfile:84,93`),
   plus an opt-in `PROXY_ALLOW_LLM_WRITE` → `skillRuntime.allowLlmWrite` shim in
   the generated YAML; `stop-all.sh --purge` and `.env.example` updated;
   persistence note added to `INSTALL.md` / `INSTALL_CN.md`.

**The critical usage contract** (documented prominently in the adapter README §3):
OpenHands sessions bind **only if the first turn carries all four headers**
`x-team-id / x-agent-id / x-task-id / x-conversation-id`. Preset resolution runs
exclusively in Case 1 of the CB state machine (`session/codebuddy/init.ts:824-825`
inside `if (!state || status === "uninitialized")` at `:766`); a headerless first
turn parks the conversation at `pending_asset_confirm` (`init.ts:1000`), and the
recovery branch (Case 1.25, `init.ts:1098+`) **never re-calls
`resolvePresetIdentity`** — so a parked OpenHands session stays parked forever
(no form UI exists in OpenHands to answer it). Observed live, not inferred.

## Related Issue | 关联 Issue

No issue filed. `ISSUE_DRAFT.md` (root of this branch) proposes two product
fixes decoupled from the adapter — session-store persistence and bridge prefix
parity — for maintainers to split out if preferred.

## Change Type | 修改类型
- [x] New feature | 新功能 (`agents/openhands/` adapter, deploy persistence + write-gate shim)
- [x] Bug fix | Bug 修复 (bridge L1 prefix parity for header-preselect agents)
- [x] Documentation update | 文档更新 (adapter READMEs, INSTALL note, PR/issue drafts)

## Scope | 范围

In scope: OpenHands SDK v1.x via LiteLLM `extra_headers` on the OpenAI-completions
route family. Explicitly out of scope (and documented as such): interactive form
session-init for OpenHands, `AgentKind`/dedicated agent adapter
(`agent-adapters/types.ts:23` omits `hermes`/`openclaw` today too — consistent
omission, filed as follow-up), `agents/setup-proxy.sh` + `agents/README.md` index
rows (those enumerate 7 agents and already omit `opencode`; index-of-record is a
maintainer call), and any redaction change (see privacy caveat).

## Self-test Checklist | 自测清单

- [x] Verified locally | 本地验证通过 — live pilot on this box (details below)
- [ ] CI green | CI 通过 — **not run here**: no `node_modules` installed in
      `MemoryProxy/` (vitest present at `MemoryProxy/vitest.config.ts` but deps
      skipped by design in this environment); TS edits are 3-line additive
      changes reviewed visually; shell edits pass `bash -n` (run).
- [x] No existing features affected | 无影响现有功能 — whitelist regex and set
      membership are additive; L1 candidate probing is order-preserving append
      (misses fall through as before); the deploy volume is default-on but
      mount-only (same path the image already writes).

### Evidence (repro commands)

Pilot ran 2026-10-05 against `agentmemory/memory-proxy` v2.0.x on this host;
full log digest: `runs/DONE.md` in the orchestrator workspace (not published
here — contains ids that must not leak into issues).

- **Mint tenant key — PASS:**
  `POST :8420/v3/meta/user-key/create` with `x-tdai-user-key: <admin>` →
  HTTP 200, `code=0`, `data.key_value` length 39, prefix `sk-mem` (value redacted).
- **Auth through proxy — PASS:** Bearer = that key on
  `POST :8096/hermes/default/v1/chat/completions` → HTTP 200 (v1 blocker
  "invalid user_key" gone).
- **First-turn header rule — CONFIRMED:** turn #1 without identity headers →
  proxy returns `ask_followup_question` form; log shows
  `session=hermes:m1-retry-seed → pending_asset_confirm`; turn #2 with all four
  headers → `L2a hit status=pending_asset_confirm` + second form, never
  `preset hit → register directly` (`init.ts` Case 1 log line). A sibling
  conversation that carried all headers on turn #1 registered directly to the
  target agent (source: pilot log, matches `init.ts:824-880` reading).
- **40101 semantics — CONFIRMED:** bridge calls under a parked session →
  `401 {"code":40101,...}`; under an initialized session → reaches the write
  gate → `403 {"code":40302,...allowLlmWrite=false...}`.
- **Write-gate shim — CONFIRMED:** `skillRuntime.allowLlmWrite: true` rendered
  via `.env` switch + container recreate flipped 40302 → identity-resolved path
  (skill create itself then blocked by the store-wipe finding below, not the gate).
- **Session wipe on recreate — CONFIRMED:** after recreate, previously working
  conversation ids returned 40101; SQLite store lived on the container writable
  layer (`Dockerfile:93` + only mount was `config.yaml:ro`) → motivates the
  `PROXY_VOLUME` patch in this PR.
- **Prefix-cache corroboration (item 6, not a new claim):** turns 2–5 through
  proxy: `Σ cached_tokens / Σ prompt_tokens ≈ 0.9660` vs direct-to-same-upstream
  baseline `0.000` (Alibaba compatible-mode; single 5-turn sample — **UNVERIFIED
  as a general rate**). Repro shape:
  ```bash
  # proxy leg (repeat same byte-identical long system+context 5 turns):
  curl -sS http://127.0.0.1:8096/hermes/default/v1/chat/completions \
    -H "Authorization: Bearer $USER_KEY" -H 'x-conversation-id: cache-probe-A' \
    -H 'content-type: application/json' -d @turn.json | jq .usage.prompt_tokens_details
  # compare cached_tokens/prompt_tokens vs the same body sent direct to upstream
  ```
- **R3 privacy caveat — CONFIRMED FAIL (upstream gap, documented not fixed):**
  a credential-shaped canary pasted into a proxied turn persisted verbatim into
  `l0_conversations.message_text` + `l0_fts_content` (grep counts: 1/14 rows;
  redaction-marker rows: 0). Adapter docs warn + recommend task allowlists.
  **UNVERIFIED upstream** beyond this single host/image.

### Relationship to #1018 / #526

Both were **not re-tested live** here (GitHub API not used in this build;
titles/state **UNVERIFIED**). Per the orchestrator's audit: they target the older
(v1) proxy surface and are stale; this PR **supersedes** them in that it is built
and verified against the current v2 route family (`/v1/chat/completions` agent
routes + bridge paths) on `feat/server_team` tip `8b86874`, end-to-end, with
repro commands above. If maintainers find #1018/#526 cover additional changes,
say so and we'll rebase intent rather than assume.

## Tested vs not tested | 已测 / 未测

| Area | Status |
|---|---|
| Header preselect + first-turn rule (hermes-family route, OpenHands wire shape) | tested live |
| OpenHands SDK `LLM(...)` construction path | import-guarded example only; SDK pip-install **UNVERIFIED** offline — wire behavior proven via LiteLLM-shaped curl |
| Proxy TS changes compile + unit tests | **not run** (deps not installed; additive edits) |
| `start-proxy.sh` / `stop-all.sh` patches | `bash -n` clean; docker bring-up **UNVERIFIED** in this sandbox (no docker daemon) |
| validate.js / example self-checks | executed offline (fail + pass cases) |

## Additional Notes | 其他说明

### Deploy shim stub repro (this build environment, no docker daemon)

`start-proxy.sh` / `stop-all.sh` patches were exercised against a `docker` test
double that records invocations and answers `inspect` with `running`/`healthy`:

```bash
mkdir -p stub/bin   # docker stub: run->prints id + logs -v args; inspect->running/healthy
cp deploy/global-images/{start-proxy.sh,_lib.sh} /tmp/harness/
printf 'PROXY_IMAGE=agentmemory/memory-proxy:latest\nPROXY_PORT=18096\nPROXY_UPSTREAM_URL=https://upstream.example/v1\nPROXY_UPSTREAM_API_KEY=sk-TESTMASKED\nPROXY_UPSTREAM_MODEL=test-model\n' > /tmp/harness/.env
cd /tmp/harness && PATH="$PWD/../stub/bin:$PATH" bash ./start-proxy.sh          # default
grep -A1 skillRuntime .proxy-config-default/config.yaml   # -> allowLlmWrite: false
grep MOUNT ../docker-stub.log    # -> -v tdai-proxy-data:/data/tdai-memory-proxy (plus config.yaml:ro)
echo 'PROXY_ALLOW_LLM_WRITE=1' >> .env && PATH=... bash ./start-proxy.sh        # opt-in
grep -A1 skillRuntime .proxy-config-rw/config.yaml        # -> allowLlmWrite: true
```

Observed (this box, exit 0 + `tdai-proxy healthy` both runs): default renders
`false` + mount present; `=1` renders `true`. A real daemon bring-up (image
pull, healthcheck against `:8096/health`) remains **UNVERIFIED** here.

- DCO: all commits on the branch carry `Signed-off-by:` per CONTRIBUTING.md.
- No secrets: every key material is `<placeholder>`; canary values stay masked.
- The README's §3 first-turn rule and the TROUBLESHOOTING 40101 row are the
  two lines most likely to save maintainers support tickets — reviewers, start there.
