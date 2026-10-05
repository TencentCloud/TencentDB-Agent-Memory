# OpenHands

> agentSource: `openhands` | 协议: OpenAI Chat Completions | Session Init: Header 预选（无交互 Form）
>
> 中文版本见 [README_CN.md](./README_CN.md)。结构与 [Hermes](../hermes/README.md) 对齐。
> OpenHands 通过 LiteLLM 发标准 `chat/completions`，可用 `extra_headers` 挂自定义 header；它无法响应
> proxy 返回的 form tool call，所以身份必须由 header 传入。

Client side is docs + examples only; two proxy-side lines make OpenHands a header-preselect agent (§6).

> Citation convention: `file:line` anchors reference base commit `8b86874` (`feat/server_team` tip).
> In the two files this PR patches (`skill-bridge.ts`, `memory-bridge.ts`, +13/+14 lines around the
> cited functions) later anchors may drift — the symbolic name next to each anchor is authoritative.

---

## 1. Client connection config

```python
from openhands.sdk import LLM

llm = LLM(
    model="openai/<model-id>",                    # LiteLLM provider prefix
    base_url="http://<proxy-host>:8096/openhands/<spaceId>/v1",
    api_key="sk-mem-<user_key>",
    extra_headers={
        "x-team-id": "<team_id from the panel>",
        "x-agent-id": "<agent_id from the panel>",
        "x-task-id": "<task_id from the panel>",
        "x-conversation-id": "<your per-conversation id>",
    },
)
```

`POST /openhands/:spaceId/v1/chat/completions` is already registered generically at
`MemoryProxy/src/server.ts:336`; `agentSource` comes from the **first path segment** at
`MemoryProxy/src/handler.ts:665-667` (only `v1` / `proxy` / `skill-bridge` / `memory-bridge` are
excluded). No new route is needed. `<spaceId>` = memory instance ID (`default` for local single-node).

> ⚠️ Do **not** borrow `/codebuddy/…`. Since `agentSource` is the first path segment
> (`handler.ts:665-667`), a borrowed prefix mislabels every session, memory row and credit metric
> OpenHands produces. `routes/whitelist.ts:175` (`AGENT_PREFIX_RE`) is a spaceId-stripping aid, **not**
> an agent whitelist — it already omits `hermes`, `dsh`, `opencode`, all shipped and working, so
> `openhands` does not belong there either. `validate.js` (§8) guards the URL shape instead.

**Minting a key.** `/v3/meta/*` grants no bootstrap admin key through proxy tenant auth — the endpoint
lives on **memory-core** (port 8420), not the proxy, and authenticates with `x-tdai-user-key`. Mint one
key per business user with the admin key (printed by `start-all.sh` first boot, file
`deploy/global-images/.admin-key` — never commit it):

```bash
curl -sS -X POST "http://<memory-core-host>:8420/v3/meta/user-key/create" \
  -H "x-tdai-user-key: <admin key>" \
  -H "x-tdai-service-id: <spaceId>" -H "content-type: application/json" \
  -d '{"user_id": "<usr-... from the panel>", "name": "openhands-user"}'
```

`data.key_value` (`sk-mem-…`) is returned **once**. Verified live 2026-10-05 (HTTP 200, `code=0`,
key length 39, prefix `sk-mem`). Route: `MemoryCore/src/metadata/router/v3-meta-router.ts:119`
(schemas `v3-meta-schemas.ts:470-474`); the header contract is what
`MemoryProxy/src/meta/client.ts:538` sends to the kernel. Never commit the returned key, and never
paste it into a proxied chat turn — L0 capture stores it verbatim (§9 / TROUBLESHOOTING).

---

## 2. Session ID

| Source | Header |
|--------|--------|
| Only | `x-conversation-id` — client-set; OpenHands does not manage it |

`x-conversation-id` is first in the lookup order at both identity sites, so it always wins:
`MemoryProxy/src/session/session-key.ts:9-19` (chat path, used `handler.ts:689-690`) and
`skill/skill-bridge.ts:234-242` (bridge path). The chat handler stores the composite key
`${agentSource}:${sessionId}` (`handler.ts:810`, `handler.ts:877`).

Use **one `x-conversation-id` per OpenHands conversation** and rotate it for each new conversation —
reusing an id resumes the previous session's state.

---

## 3. ⚠️ The first-turn rule (read this before debugging anything else)

Header preselect is resolved **only on the turn that initialises the session**, only inside the
"not yet initialised" branch:

- `MemoryProxy/src/session/codebuddy/init.ts:824-825` —
  `if (presetIdentity && config.headerAutoSelect?.enabled) { resolvePresetIdentity(teams, presetIdentity) }`
- `presetIdentity` is parsed at `handler.ts:874`; on by default (`config.ts:98-104`, wired
  `config.ts:426-431`; `start-proxy.sh:129-134` writes `headerAutoSelect.enabled: true`).
- Header values count only when found inside the caller's own kernel-provided `teams[]`
  (`session/preset.ts:9-12`) — a wrong id is a mismatch, never an escalation.

**Consequence.** If the *first* request misses any of the four headers (or fails validation), the
session enters the form path and parks at `status: "pending_asset_confirm"` (`init.ts:1000`, logged
`:1008`). Later turns that *do* carry the headers land in the recovery branch `init.ts:1099`
("Case 1.25: Awaiting asset_confirm"), which reads only the form answer and **never calls
`resolvePresetIdentity`** — so the session stays parked indefinitely, uninjected, looking as if the
proxy ignored your headers.

Setting `extra_headers` once on the `LLM` object covers every turn (including LiteLLM's internal
summarizer / condenser calls), so this normally never fires. It *does* fire when headers are applied
per-call and the first call — e.g. a title/summary auxiliary request — omits them.

**Recovery:** rotate `x-conversation-id` (a new composite key restarts at Case 1), or reset the proxy
store (§5). Proposed product fix: `ISSUE_DRAFT.md`.

---

## 4. Skill / memory access from OpenHands tools

Bridges are mounted globally, not per agent (`server.ts:134`, `:139`; path match
`skill-bridge.ts:343`), and authenticate the session from headers only — any client can call them:

```bash
curl -sS -X POST "http://<proxy-host>:8096/skill-bridge/v3/skill/listing" \
  -H "x-conversation-id: <same id as the LLM turns>" \
  -H "x-tdai-service-id: <spaceId>" -H "content-type: application/json" -d '{}'
```

- No session header → `40101` (`skill-bridge.ts:495-501`; mirrored `memory/memory-bridge.ts:303`).
- Identity resolves from the in-memory store first (`skill-bridge.ts:294-300`), then persisted
  bindings — but L2 is gated on `spaceId`, which comes from `x-tdai-service-id` (`:503-506`, gate
  `:516-519`); with neither L1 nor L2 the call `40101`s at `:526` (also `memory-bridge.ts:322`).
- **Why the service-id header matters:** bindings are keyed `(spaceId, sessionId)` with a **bare**
  sessionId and **no** `agentSource` (`db/binding-repo.ts:43-48,54-57`, written `session/store.ts:244`).
  Once a binding exists, prefix parity is moot — but omit the space id and L2 is never attempted.
- Skill writes (`create`/`update`/`patch`/`delete`/`files/write`/`files/remove`, `:161-168`) are off by
  default — §7.

---

## 5. Proxy session store persistence

`start-proxy.sh` mounted **only** the generated `config.yaml` (`start-proxy.sh:158`) while the store
lives at the image-baked `PROXY_DB_PATH=/data/tdai-memory-proxy/proxy.db` (`MemoryProxy/Dockerfile:93`;
dir `Dockerfile:84`; resolution `db/index.ts:4`, `storage/factory.ts:283-289` which mkdirs the parent).
Every `./start-proxy.sh` run recreates the container (`rm_container_if_exists`, `:44`), wiping all
sessions, bindings, rate-limit buckets and conversation buffers.

This PR adds a named volume using the idiom the sibling services already use
(`start-memory-core.sh:208`, `start-memory-hub.sh:98`): `PROXY_VOLUME` (default `tdai-proxy-data`)
mounted at `/data/tdai-memory-proxy`. `PROXY_DB_PATH` is deliberately **not** overridden — the image
already sets it, so mounting that directory keeps code and mount in agreement in one line. To wipe
sessions on purpose: `docker volume rm tdai-proxy-data` — or `./stop-all.sh --purge`, whose volume loop
this PR extends with `PROXY_VOLUME` (`stop-all.sh:39`) so purge stays a true full wipe.

---

## 6. Proxy-side change required for `agentSource=openhands`

Routing needs nothing (§1). The "no form UI" property must be declared, otherwise
`mem:session-reset` offers a form OpenHands cannot answer — precisely the parking condition of §3:

```text
MemoryProxy/src/handler.ts:781
  const _headerOnlyAgents = new Set(["hermes", "openclaw", "openhands"]);
```

That set is the only gate which refuses `mem:session-reset` for form-less clients
(`handler.ts:782-801`) and skips the interactive reset branch (`:802`). Its own comment says it exists
because hermes / openclaw / dsh-headless have no form to pop and would otherwise stick in
`pending_asset_confirm` — the same OpenHands case. `credit-reporter.ts:77` already recognises hermes /
openclaw / dsh / opencode and gains `openhands` for per-agent credit attribution.

Deliberately **not** changed: `routes/whitelist.ts:175` (aid, not whitelist);
`session/client-capabilities.ts:68-75` (only `workbuddy` special-cased, everything else generic);
`injection/pipeline.ts:185` (already generic); `agent-adapters/types.ts:23` (`AgentKind` omits hermes
and openclaw too — adding only `openhands` would be inconsistent; filed as follow-up).

---

## 7. Write gate (`skillRuntime.allowLlmWrite`)

Bridge writes are refused by default: `allowLlmWrite: false` (`config.ts:138`, read `:484-486`,
enforced `skill-bridge.ts:533-542` → `40302` + `write_ops_disabled` telemetry; the `<skill_tools>`
injection hint is gated at `injection/index.ts:310-311`). Upstream's **only** switch is the YAML key
`skillRuntime.allowLlmWrite: true` (`config.example.yaml:663`).

This PR also adds an opt-in shim to `deploy/global-images/start-proxy.sh`: `PROXY_ALLOW_LLM_WRITE=1`
in `.env` renders that YAML key via the script's own `bool()` helper (shim default `:88`, render site
`:175-176`, effective state logged on every start `:179`). Pilot-verified live 2026-10-05: `=1` →
`allowLlmWrite: true` in the regenerated `config.yaml`, container recreated healthy. (The gate's
enforcement point itself was proven earlier that day: with the flag unset, a bridge write under an
initialized session returned exactly `403 {"code":40302,...}` — identity resolved, write refused.)
The **unset → `false`** render and the volume-mount flags were additionally re-verified in this
build environment with a `docker` test double (see "Deploy shim stub repro" in `PR_BODY.md`; no
daemon here, so real `docker run` success remains **UNVERIFIED**). Also **UNVERIFIED**: a
successful `skill/create` *after* enabling — in the pilot the restart needed to
apply it wiped the session store, so the next call returned `40101` for a different
reason (§5 is the fix for exactly that).

```bash
echo 'PROXY_ALLOW_LLM_WRITE=1' >> deploy/global-images/.env
./start-proxy.sh    # regenerates config.yaml, recreates the container
```

⚠️ Security note: enabling this hands skill **create/update/delete** to the LLM — a model-written skill
is injected into every later session of the same team, bypassing human review. Keep it off unless the
team owns the blast radius; with §5 persistence on, container recreation no longer silently "resets"
identity, so a write-enabled store is also a durable one.

> §8 troubleshooting / §9 limits & privacy / §10 file map → [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
> （中文对照见 [README_CN.md](./README_CN.md) §8-§9）。
