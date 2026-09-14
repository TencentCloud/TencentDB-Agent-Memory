# Subscription-friendly Agent Memory hooks

Keep the coding agent's subscription / OAuth / model connection unchanged. Native
hooks access MemoryCore independently. TypeScript compiled to JavaScript, matching
the repository's Node.js stack; no runtime dependencies or server changes.

```text
Agent ──────────────────────────────> existing model provider
  └─ native hook → adapter → shared memory core → MemoryCore HTTP API
```

`src/memory.ts` owns authentication, recall, capture and durable delivery state.
`src/adapters/` translates native events and output for Codex and ZCode; `standard`
provides the portable contract for another client. `src/hook.ts` is the process
entry point, and `src/install.ts` registers native hooks.

## Build and configure

Requires **Node.js >=22.16.0**, as used by the repository's services. Node's built-in
`fetch` and `node:sqlite` replace Python's HTTP/SQLite libraries. SQLite may emit
an experimental-feature warning on Node 22; this goes to stderr, not Hook JSON.
TypeScript and Node types are development dependencies only.

Run in `integrations/agent-memory-hooks`:

```sh
npm ci
npm run build
mkdir -p ~/.config/agent-memory
cp config.example.json ~/.config/agent-memory/config.json
chmod 600 ~/.config/agent-memory/config.json
```

Edit the copied config with an existing Memory Hub identity and an Agent with a
`chat_memory` asset and read/write permission:

- `endpoint`: MemoryCore, e.g. `http://127.0.0.1:8420`; remote HTTP is rejected.
- `user_key`: Memory Hub business credential, **not** the model/subscription token.
- `gateway_key`: separate MemoryCore gateway Bearer key, if enabled.
- `team_id`, `agent_id`: existing IDs; no invented or auto-created identity.
- `service_id`: MemoryCore instance (`default` for the local deployment).
- `capture`: `false` by default; `true` opts into automatically saving ordinary turns.

The core verifies the business key, Agent's team and chat-memory ACL before each
memory operation. This client-side check does not replace server-side data-plane
access control or make an exposed gateway safe to share. Subscription credentials
remain with the client; they do not supply the Core extraction model's quota.

## Install / remove

Use a stable checkout path and build before installing:

```sh
node dist/install.js --client zcode
node dist/hook.js --adapter zcode --check
# Or:
node dist/install.js --client codex
node dist/hook.js --adapter codex --check

# Remove only this checkout's hooks:
node dist/install.js --client codex --remove
```

`--config /private/memory.json` selects another memory configuration.
`--settings /absolute/path/settings.json` overrides the native hook file.

- **ZCode CLI and Desktop 0.16.5:** `~/.zcode/cli/config.json`. Desktop's
  `~/.zcode/v2/config.json` stores model providers, not these user hooks. Restart
  Desktop after installation. Explicitly disabled hooks are not silently enabled.
  Project hook overrides remain subject to native trust checks.
- **Codex:** `~/.codex/hooks.json`. Run `/hooks` in CLI and review/trust the exact
  commands; installation does not grant trust. Restart Desktop before testing
  new local tasks. Neither `config.toml` nor `auth.json` is modified. See the
  [official Hook contract](https://learn.chatgpt.com/docs/hooks).

Installation is idempotent, preserves unrelated hooks/providers, and backs up the
original settings with private permissions. Removal leaves global enable settings
alone. Existing Python-hook entries pointing to this checkout are replaced by the
compiled JavaScript command; their SQLite state, scope hash and pending/sent rows
remain compatible. Rebuild after code changes and review trust again when the
registered command changes. Do not move/delete the checkout while hooks use it.
Backups may contain existing credentials; keep them local.

## Behavior

| Message | Behavior |
| --- | --- |
| `mem:recall <query>` | Query up to five existing L1 memories across sessions; inject at most 6000 characters of result data. Do not capture this turn. |
| `mem:remember <fact>` | Save this user message and the final assistant reply when Stop arrives. |
| Include `mem:off`, `/nomemory`, or `[不记忆]` | Skip memory processing for this turn. |
| Ordinary message | Inject memory-query instructions; the model can search when needed. Capture only when `capture: true`. |

These are ordinary messages, not slash commands. Each eligible prompt receives a
short, stable query guide: for previous decisions, preferences or agreements,
the model should run the supplied read-only shell command before answering unless
the answer is already available. General questions do not require a search. This
uses the client's existing shell tool, not a new MCP server or a model proxy.
The guide contains command/config paths, never credential values. The query loads
credentials itself and reuses the same ACL-checked, bounded L1 search:

```sh
node dist/hook.js --adapter codex --query 'previous health check agreement'
```

Ordinary prompt hooks do not call the memory API just to generate this guide.
Queries produce JSON with a `context` field and exit nonzero on failure; they do
not capture another turn. Models must honor tool permissions and explicit opt-out
or no-tool requests. Clients must provide shell access to the installed Node
runtime and network access to Core. Actual search is model-directed, not guaranteed
by the prompt. No profile/scene injection or background retry worker is added.
Only native user/final-answer fields are captured; no transcripts, tools,
attachments, system prompts or thinking content. Missing stable session/turn IDs
skip processing. Known credential patterns skip the turn; this is not comprehensive
secret detection. Returned historical data is labeled untrusted reference material.

Requests share a seven-second deadline. Errors produce empty Hook JSON and exit
zero, allowing model use to continue. Explicit diagnostic commands instead exit
nonzero on failure. A missing/untrusted Hook cannot report its own failure: verify
native activation and actual server writes, not merely a model saying “recorded”.

```sh
node dist/hook.js --adapter codex --status
node dist/hook.js --adapter codex --retry-one
```

A private SQLite file beside the config (`config-state/turns.sqlite`) retains the
complete final pair before upload. Successful rows are marked `sent` and content
is cleared. Session/turn IDs deduplicate repeated Stop events. Failed uploads stay
`pending`; retries are explicit. An uncertain server acceptance followed by retry
can duplicate data because the API lacks a caller-provided idempotency key.
Oversized turns are retained, never silently truncated. State is not encrypted;
aborted turns can retain a waiting prompt, and a missing Stop cannot be recovered
from a transcript. File permission guarantees are strongest on POSIX; protect the
config/state with appropriate user ACLs on Windows.

## Add another agent

Create `src/adapters/<client>.ts` exporting `normalize(raw)` and `encode(context,
event)`, then rebuild. The adapter converts native JSON stdin to the contract
below and the result to its host's context-injection output. Register native
prompt-submit/turn-completed events to execute:

```sh
node /absolute/path/dist/hook.js --adapter <client> --config /private/config.json
```

Canonical input (`--adapter standard` accepts it directly):

```json
{
  "version": 1,
  "event": "UserPromptSubmit",
  "session_id": "native-session-id",
  "turn_id": "native-turn-id",
  "prompt": "mem:recall previous health check decision"
}
```

For `Stop`, use the same session/turn IDs and `reply` with only final assistant
text; `stop_active: true` skips recursive Stop calls. Standard output is
`{"context":"..."}` or `{}`. Adapters are trusted local executable code. Clients
without suitable native hooks need their own lifecycle bridge, not guessed IDs.

## Verification

```sh
npm test
```

Node's built-in test runner covers both native protocols, opt-out and secrets,
verified identity/ACL denial, final-pair capture, duplicate Stop, durable retry,
Unicode chunking/oversize retention, original Python state compatibility,
installer migration/removal and quoting, nonblocking errors, HTTP headers,
redirect rejection and response limits. Additional checks execute the injected
query command with quoted paths, verify read-only ACL enforcement, and ensure
ordinary/opt-out prompts do not trigger implicit network searches. No test
framework dependency is needed.

TypeScript rewrite verification on 2026-09-14: 12 Node tests passed, compiled with
strict TypeScript. A real Codex CLI session using the existing ChatGPT login
recalled `/health/blue-heron-914` and HTTP 200; another returned `TS_HOOK_RECORDED`
and its server conversation count was exactly two. This unattended test used the
explicit `--dangerously-bypass-hook-trust` CLI test flag, without changing saved
trust, model credentials or provider settings. Native ZCode JSON events were
replayed through the compiled process against live Core: recall matched and
capture stored two messages. This replay is not a new official-plan model run.
The previous SQLite state was also read successfully by the rewritten core.

Model-directed query verification: a fresh Codex CLI task asked about the previous
health-check agreement with no `mem:` command and no answer in its prompt. The
model invoked the injected `--query` command and returned the stored path and HTTP
200 condition. This run used an isolated workspace-write sandbox with network
access enabled for MemoryCore, plus the same explicit hook-trust test flag. A
read-only sandbox run with network unavailable also invoked the command, reported
the query failure and did not invent an answer. No persistent sandbox settings
were changed. This verifies existing-memory retrieval, not new-fact extraction;
ZCode model-directed querying still needs a native model test.

The PR separates this verification from earlier Python verification. Earlier user screenshots show successful ZCode Desktop official
BigModel GLM-5.3-Flash, Codex CLI ChatGPT-login and Codex Desktop recall/capture,
with each captured session confirmed to contain two L0 messages. They establish
the native event contract and prior integration behavior, not new screenshot
proof of this rewrite. New TypeScript checks and live results are recorded in
the PR. GLM-5.3 non-Flash and extraction/cross-session recall of newly written facts
remain unverified. Existing L1 recall and L0 capture do not prove extraction.

## Design references

Independent implementation; no reference source copied:

- [Issue #1092](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1092):
  independent model/memory paths, final-pair capture, retained failed writes.
- [Issue #1352](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1352):
  selective recall and thin adapters around a provider-neutral contract.

These are Issue discussions with external implementations, not merged upstream
PRs. We use native session **and turn IDs**, explicit recall and manual retry;
we do not add automatic identity creation, transcript parsing, heuristic recall,
full-profile injection or automatic replay of uncertain writes.
