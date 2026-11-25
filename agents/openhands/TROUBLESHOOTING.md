# OpenHands adapter — troubleshooting, limits, file map

> Companion to [README.md](./README.md) (§ numbering continues).

---

## 8. Troubleshooting

| Symptom | Cause | Fix / evidence |
|---------|-------|----------------|
| `40101 … session not initialized` from a bridge call, though chat turns worked | L1 prefix probe missed, and L2 was skipped because `x-tdai-service-id` was absent (gate `skill-bridge.ts:516-519` → `:526`) | Always send `x-tdai-service-id` (§4). L1 now also probes `hermes:` / `openclaw:` / `openhands:`. |
| `40101 … missing x-conversation-id` | No session header on the bridge call | Add `x-conversation-id` (or `x-session-id` / `x-chat-id` / `x-thread-id`) — `skill-bridge.ts:495-501`. |
| Injection never appears, session "ignored" my headers | Parked at `pending_asset_confirm` — first turn lacked a header (§3) | Rotate `x-conversation-id`, or reset the store (§5). |
| `40302 … LLM write access to skill is disabled` | `skillRuntime.allowLlmWrite=false` (§7) | YAML opt-in; or keep reads only. |
| `mem:session-reset` → "不支持 openhands" | Intended: `_headerOnlyAgents` has no form UI (`handler.ts:781-801`) | Edit the identity headers in client config + rotate `x-conversation-id`. |
| Sessions/memory gone after redeploy | Store on container writable layer (§5) | Mount `PROXY_VOLUME`. |
| Identity attributed to the wrong agent | Borrowed path prefix (`handler.ts:665-667`) | Use `/openhands/<spaceId>/v1`; run `node agents/openhands/validate.js`. |
| `x-task-id` seems mandatory | Preselect needs a resolvable task, else form → bypass | Panel `task/list`, or set `sessionInit.defaultTaskId` in proxy `config.yaml`. |

No-network config check: `node agents/openhands/validate.js` (reads env only; live probes require
`TDAM_LIVE_PROBE=1`). Sanity endpoints: `GET /health` (`server.ts:85-105`) and
`GET /whoami` with `Authorization: Bearer sk-mem-<user_key>` (`server.ts:108`).

---

## 9. Limitations, privacy, security

- **Session ids are manual.** You own `x-conversation-id` rotation; turns issued without the headers
  (some retry / auxiliary paths) skip injection.
- **`AgentKind` has no `openhands`** — it resolves via the `unknown` fallback
  (`agent-adapters/types.ts:23`, `agent-adapters/index.ts:28-41`), like `hermes` / `openclaw` today;
  injection uses the shared path (`injection/pipeline.ts:185`). No behavioural difference observed —
  which is why §6 files it as follow-up rather than a fix.
- **🔒 Secrets are captured verbatim into raw memory.** In a local canary test a credential-shaped
  string pasted into a proxied turn was persisted **unredacted** in L0 capture
  (`l0_conversations.message_text`, substring-searchable in `l0_fts_content`) — recallable and
  re-injectable into later prompts. Proxy logs were clean; redaction does not yet cover capture.
  Until it does: keys via config/env only, never chat content; scope teams/agents tightly; prefer
  task allowlists over broad shared teams. **UNVERIFIED upstream** — one host, v2.0.x image.
- **Prefix-cache datapoint (corroboration, not a new claim).** Byte-identical injected block,
  turns 2-5 through the proxy: `cached/prompt ≈ 0.966`, vs `0.000` direct to the same
  OpenAI-compatible upstream. Repro commands in `PR_BODY.md` (spelling out the exact probe shape).
  **UNVERIFIED upstream**: one 5-turn sample, one provider.
- **Testing scope.** Validated live on one host against `agentmemory/memory-proxy` v2.0.x with
  OpenHands SDK v1.x. **UNVERIFIED**: SDK version matrix, `stream: true` first-turn interaction,
  multi-tenant scale.

---

## 10. Files here / follow-ups

- `README_CN.md` — 中文同步版本。
- `example/openhands_connect.py` — runnable example: conversation-id helper + `/health` + `/whoami`
  self-check, no network at import.
- `validate.js` — config-shape validator mirroring `adapters/opencode/validate.js`.

Follow-up, not in this PR (see `PR_BODY.md`): an `openhands` entry in `agents/setup-proxy.sh`
(`AGENTS`/`AGENT_LABELS` `:91-100`, dispatch `:1074`, preselect branch `:521`) and rows in the
`agents/README.md` tables — those enumerate 7 agents and already omit `opencode`, so the index of
record is an open question for maintainers.
