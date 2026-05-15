# TencentDB Agent Memory — Coding Agent Plugin

Long-term + symbolic short-term memory for [Claude Code](https://claude.com/claude-code) and [OpenAI Codex CLI](https://developers.openai.com/codex/cli), powered by [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory).

The plugin ships dual manifests (`.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`) and reuses the same `hooks/hooks.json` and `skills/` — both Claude Code (v2026.4+) and Codex CLI (v0.117+) implement the same hook protocol, so a single source tree serves both hosts.

[中文版](./README_CN.md)

## What this gives you

- **Automatic recall** before every prompt — relevant past memories injected into context
- **Automatic capture** after every turn — L0 conversation written, L1/L2/L3 extracted in the background
- **Manual control** via slash skills: `/memory-search`, `/memory-status`, `/memory-clear-session`
- **Project-level isolation** by default (sessionKey = hash of cwd) — your `react-app` memories don't leak into your `golang-svc` work
- **Bearer-secured local daemon** — no plaintext localhost API

## Installation

### Prerequisite

Install the gateway runtime (the `tdai-memory-gateway` bin) globally — the plugin spawns the daemon via `npx tdai-memory-gateway`:

```bash
npm install -g @tencentdb-agent-memory/memory-tencentdb
```

This npm package contains the actual `TdaiGateway` (SQLite + sqlite-vec + LLM pipeline). The plugin itself is a thin shim that owns hooks, skills, and the per-session sessionKey — it does NOT bundle the heavy deps.

### Claude Code

```bash
/plugin install tdai-memory
```

### Codex CLI

```bash
codex plugin marketplace add <marketplace-url>
# then enable in the TUI: /plugin → toggle tdai-memory
```

(Once published to the Codex marketplace, this becomes a one-liner.)

---

No `~/.claude/settings.json` or `~/.codex/config.toml` mutation. The first time a session starts after installation, the plugin spawns the local daemon (via `npx tdai-memory-gateway`) on port 8421–8430 with a randomly generated Bearer token. State persists under `${CLAUDE_PLUGIN_DATA}`.

## Configuration

The plugin reads these optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `TDAI_SESSION_KEY` | `hash(cwd)` | Override the per-project memory partition |
| `TDAI_TOKEN_PATH` | auto-generated 0o600 file | Path to a file the daemon reads the Bearer token from (preferred over `TDAI_GATEWAY_TOKEN`; the env-var form puts the token into `/proc/<pid>/environ` and `ps -E`) |
| `TDAI_GATEWAY_TOKEN` | unset | Bearer token via env (fallback for the Hermes sidecar mode) |
| `TDAI_GATEWAY_HOST` | `127.0.0.1` | Daemon bind host. Non-loopback values are refused unless `TDAI_GATEWAY_ALLOW_REMOTE=1` is set, to avoid exposing the memory port to the LAN. |
| `TDAI_GATEWAY_ALLOW_REMOTE` | unset | Opt-in switch required to bind a non-loopback `TDAI_GATEWAY_HOST` |
| `TDAI_GATEWAY_CORS_ORIGIN` | unset | When set, enables CORS with the given Origin; the default disables CORS so cross-origin pages cannot probe the daemon's port. |
| `TDAI_GATEWAY_COMMAND` | `npx` | Override daemon spawn command (advanced; e.g. `node /path/to/cli.mjs` for development) |

Most users never need to set any of these. `TDAI_SESSION_KEY=shared-with-other-project` is the most common power-user override.

## Data location

- `${CLAUDE_PLUGIN_DATA}/state.json` — daemon PID + port (tmp+rename atomic)
- `${CLAUDE_PLUGIN_DATA}/token` — Bearer token (chmod 600, owner-uid checked)
- `${CLAUDE_PLUGIN_DATA}/spawn.lock` — O_CREAT|O_EXCL daemon-spawn mutex (stale after 60s)
- `${CLAUDE_PLUGIN_DATA}/cursors/<sessionId>.json` — per-cc-session `lastSentIndex` so Stop only POSTs new turns
- `${CLAUDE_PLUGIN_DATA}/memory-tdai/` — SQLite + sqlite-vec database, scene blocks, persona snapshots
- `${CLAUDE_PLUGIN_DATA}/hook.log` — hook diagnostic log (gateway-client failures, etc.)
- `${CLAUDE_PLUGIN_DATA}/daemon.log` — daemon stderr/stdout (cold-start crashes, etc.)

## How it works

```
User prompt → UserPromptSubmit hook → POST /recall → cc injects context
cc replies   → Stop hook            → POST /capture → L0 + L1/L2/L3 pipeline
Session end  → daemon detects parent cc exit → graceful shutdown
```

All hook handlers fail silently (writing to `hook.log`) — memory is never on the critical path of your conversation.

## Troubleshooting

**`/memory-status` says "unreachable"**:
- Check `${CLAUDE_PLUGIN_DATA}/hook.log` (gateway-client request failures) and `${CLAUDE_PLUGIN_DATA}/daemon.log` (daemon cold-start crashes)
- Restart your cc session — the SessionStart hook re-probes and re-spawns the daemon

**Multiple cc terminals on the same project**:
- All terminals share one daemon. The first to launch spawns it; subsequent terminals discover and reuse it via `state.json`.

**Memory doesn't recall what I expect**:
- Run `/memory-search <topic>` directly to see what's stored
- Note that L1/L2/L3 extraction runs asynchronously — fresh conversations may need a few minutes before they appear in recall

## Security model

- The daemon listens only on `127.0.0.1` by default. Non-loopback `TDAI_GATEWAY_HOST` is refused unless `TDAI_GATEWAY_ALLOW_REMOTE=1` is also set.
- Every request requires `Authorization: Bearer <token>`. Comparison is timing-safe; the scheme keyword is RFC 6750 §2.1 case-insensitive; 401 responses include `WWW-Authenticate: Bearer realm="tdai-gateway"`.
- The token is generated freshly at each daemon spawn, written to `${CLAUDE_PLUGIN_DATA}/token` (chmod 600), and passed to the daemon child process **by file path** (`TDAI_TOKEN_PATH`) rather than as an env var, so the token does not surface via `/proc/<pid>/environ` or `ps -E`. Token-file owner is checked against the current uid on read.
- The `memory-search` skill passes the user query to the daemon over **stdin** via a heredoc, never as a shell argv element — this avoids the literal-`replaceAll` `$ARGUMENTS` injection surface in cc (anthropics/claude-code#16163).
- On Windows the 0o077 mode check is skipped (Node's `fs` returns fixed mode bits there); the OS-provided NTFS ACL on the token file is relied on instead.

## Building from source

```bash
pnpm install
pnpm build:cc-plugin
pnpm test:cc-plugin
```

## License

MIT — see [LICENSE](../LICENSE).
