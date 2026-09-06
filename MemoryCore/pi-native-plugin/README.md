# Pi Adapter for TencentDB Agent Memory (v3, native)

[简体中文](./README_CN.md) · English

This directory is the **native Pi extension** for Memory Gateway **`/v3/*`** and the Knowledge Service. It is the no-proxy counterpart of [`pi-plugin`](../pi-plugin/): where `pi-plugin` routes Pi's model traffic through the Memory Proxy and lets the proxy inject and capture, this extension keeps Pi on **its own model provider** and does recall, injection and capture itself through Pi's extension API. Choose it when you want memory without moving Pi's LLM traffic, key or billing to the proxy.

| Item | Value |
|------|-------|
| Host | [Pi](https://github.com/earendil-works/pi) ≥ 0.84 |
| Data plane | Gateway `/v3/atomic/*`, `/v3/conversation/add`, `/v3/core/read`, `/v3/scenario/ls`; Knowledge Service `/v3/wiki/*` |
| Tools | 8 (`tdai_search`, `tdai_memory_list`, `tdai_capture`, `tdai_wiki_list`, `tdai_wiki_search`, `tdai_wiki_pages`, `tdai_wiki_read`, `tdai_wiki_write`) |
| Injection | visible transcript message: L2/L3 once per session, L1 every turn (deduped), optional knowledge-map page |
| Capture | full L0 transcript delta at `session_shutdown` |
| Not included | proxy routing, Offload |

The same code is published for `pi install` as [`@plainwuatlig/pi-tencentdb-agent-memory`](https://www.npmjs.com/package/@plainwuatlig/pi-tencentdb-agent-memory) (community package, source of truth at [plainwuatlig/pi-tencentdb-agent-memory](https://github.com/plainwuatlig/pi-tencentdb-agent-memory)); this directory tracks its releases.

## What it does

- **8 on-demand tools** — L1 recall (`tdai_search` / `tdai_memory_list`), manual capture (`tdai_capture`), and knowledge/wiki access (`tdai_wiki_list` / `search` / `pages` / `read` / `write`). Wiki ids are always parameters, discovered with `tdai_wiki_list`.
- **Automatic L0 capture** — on `session_shutdown`, the conversation is written back as L0 messages: only the delta since the last capture, chunked to ≤ 8192 chars, batched to ≤ 100 messages per post. Thinking is dropped; tool calls and results become prefixed text. Kill switch: `TDAI_CAPTURE=off`.
- **L2/L3 injection, once per session** — on the session's first `before_agent_start`, the L3 persona and the L2 scenario summaries are injected within a char budget (default 16,000 ≈ 4K tokens). Re-armed after `/compact` and retried after an outage. Kill switch: `TDAI_INJECT=off`.
- **L1 injection, every turn** — the turn's own prompt is searched against L1 (top 3), deduped against the previous turn's hits.
- **Knowledge-map injection (optional)** — `TDAI_INJECT_MAP="<wiki_id>:<page ref>"` injects a team-maintained wiki page first, so the agent knows what the knowledge base *contains*, not merely that it exists. Team content stays in the wiki; the extension carries none.
- **Visible delivery** — every injection lands as an ordinary session message (`customType: "tdai-memory-inject"`, `display: true`), never a hidden splice, so it can be reviewed in the transcript.
- **Query-first routing guidance** — tool descriptions tell the model to search memory and the wiki before hunting the filesystem for a repo, host, config or deploy recipe.

Everything is fail-open: an outage, timeout or unset key degrades to "no injection / no capture" and never blocks Pi.

## Tools

| Tool | Endpoint | What it does |
|---|---|---|
| `tdai_search` | `POST /v3/atomic/search` | Semantic search over L1 memory notes |
| `tdai_memory_list` | `POST /v3/atomic/query` | List L1 notes, newest first, with pagination |
| `tdai_capture` | `POST /v3/conversation/add` | Store a note as an L0 message (L1 extraction happens async) |
| `tdai_wiki_list` | `POST /v3/wiki/list` | List wikis in the Knowledge Service |
| `tdai_wiki_search` | `POST /v3/wiki/search` | Full-text search inside one wiki |
| `tdai_wiki_pages` | `POST /v3/wiki/page/ls` | List page refs in a wiki |
| `tdai_wiki_read` | `POST /v3/wiki/page/read` | Read up to 20 pages by ref |
| `tdai_wiki_write` | `POST /v3/wiki/page/write` | Write or update up to 20 markdown pages |

## Install

From npm (recommended, the published community package):

```bash
pi install npm:@plainwuatlig/pi-tencentdb-agent-memory
```

From this directory (development):

```bash
cd MemoryCore/pi-native-plugin
npm install
npm test
pi -e .            # load once, or: pi install /absolute/path/to/MemoryCore/pi-native-plugin
```

## Configuration

All configuration is by environment variables. **Fail-fast, no defaults:** the seven "yes" variables are required; if any is unset the extension refuses to load (Pi reports `Failed to load extension … missing …` and continues without it).

| Variable | Required | Description |
|---|---|---|
| `TDAI_API_KEY` | yes | Per-user key (`sk-mem-…`), sent as Bearer to the Gateway |
| `TDAI_GATEWAY_URL` | yes | Memory Gateway base URL |
| `TDAI_KNOWLEDGE_URL` | yes | Knowledge Service base URL |
| `TDAI_SERVICE_ID` | yes | Memory instance id (`x-tdai-service-id`), e.g. `default` |
| `TDAI_TEAM_ID` / `TDAI_USER_ID` / `TDAI_AGENT_ID` | yes | v3 isolation triple, sent with every request |
| `TDAI_INJECT` | no | `on` (default) / `off` — L2/L3 and L1 injection |
| `TDAI_CAPTURE` | no | `on` (default) / `off` — automatic L0 capture at shutdown |
| `TDAI_INJECT_MAX_CHARS` | no | Injection char budget (default `16000`) |
| `TDAI_SCENARIO_MAP` | no | JSON `{ "cwd-prefix": ["path", …] }` selecting L2 files per project; unset = all |
| `TDAI_INJECT_MAP` | no | `<wiki_id>:<page ref>` of a knowledge-map page to inject once per session |

## Notes

- **L0 → L1 is async.** A capture lands as an L0 message; the pipeline extracts it into L1 notes on its own schedule.
- **Capture is a session-close act.** Mid-session capture would contaminate recall for the running session and memorialise drafts; the extension captures the consolidated transcript at shutdown, and `tdai_capture` exists for milestones the agent wants recorded in its own words.
- **Relation to `pi-plugin`.** Both can coexist in a Pi install; use one. `pi-plugin` gives server-side injection through the proxy with zero client code; this extension gives client-side, visible injection and wiki write without touching Pi's model route.

## Files

```text
pi-native-plugin/
├── extensions/tdai-memory/
│   ├── index.ts     tools, hooks, injection, capture
│   └── lib.ts       pure helpers: normalisation, batching, budgets, env validation
├── __tests__/       vitest
└── README.md / README_CN.md
```
