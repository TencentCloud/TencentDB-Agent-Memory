# TencentDB Agent Memory adapter for Kiro

Phase 2 connects Kiro IDE v1 hooks and an MCP server to TencentDB Agent Memory. It supports automatic recall, observable Full L0 capture, conversation and skill search, durable outbox retry, force-archive coordination, diagnostics, and state maintenance. It does not support Kiro Web, Mobile, or Crew.

Real Kiro IDE E2E against a local probe Gateway has been executed in this environment. The remote Gateway E2E has not been executed and must not be treated as passed. The automated suite validates the adapter contracts. Official hook documentation: https://kiro.dev/docs/hooks/.

## Configuration

Use Node.js 20+. Configuration precedence is `environment > project > user > defaults`. Project config is `.kiro/settings/tdai-memory.json`; user config is `~/.kiro/settings/tdai-memory.json`. Both use strict Config v2 JSON. Keep the API Key only in `TDAI_MEMORY_API_KEY`; never store it in JSON, hooks, receipts, logs, or MCP output.

| Environment variable | Purpose |
| --- | --- |
| `TDAI_MEMORY_GATEWAY_URL` | Gateway HTTP(S) URL |
| `TDAI_MEMORY_SERVICE_ID` | Required service identifier |
| `TDAI_MEMORY_USER_ID` | Required memory user identifier |
| `TDAI_MEMORY_API_KEY` | Optional bearer credential; environment only |
| `TDAI_MEMORY_TEAM_ID` | Optional team scope |
| `TDAI_MEMORY_STATE_DIR` | Absolute local state directory |
| `TDAI_MEMORY_CAPTURE_ENABLED` | Enable observable capture |
| `TDAI_MEMORY_RECALL_ENABLED` | Enable automatic recall |
| `TDAI_MEMORY_SKILL_RECALL_ENABLED` | Include skill search in recall |
| `TDAI_MEMORY_MCP_MAX_OUTPUT_CHARS` | MCP character budget |

Input limits are 128KiB for hook events, 8KiB per observed tool trace, and 32KiB for normalized recall text. Gateway failures are fail-open for hooks: durable work enters the local `outbox`; no secret or raw diagnostic content is printed.

## Install and operate

```powershell
node scripts/install.mjs --project C:\path\to\project
node scripts/doctor.mjs --project C:\path\to\project
node scripts/status.mjs --project C:\path\to\project
node scripts/health.mjs --project C:\path\to\project --json
node scripts/drain.mjs --project C:\path\to\project
```

Installation owns only `.kiro/hooks/tdai-memory.json`, the `tdai-memory` entry in `.kiro/settings/mcp.json`, and its receipt. It installs `UserPromptSubmit`, `PostToolUse`, and `Stop` hooks while preserving unrelated settings. Do not add `autoApprove`; each MCP tool remains subject to Kiro's normal approval policy. Remove owned integration with `node scripts/uninstall.mjs --project C:\path\to\project`.

If the project is already open in Kiro and the installed server does not appear under MCP Servers, run `Developer: Reload Window` once from the command palette. The PostToolUse hook intentionally omits `matcher`; Kiro's v1 hook schema treats an omitted matcher as all tools.

The MCP server exposes `tdai_memory_search`, `tdai_conversation_search`, and `tdai_memory_status`. Start it manually with `npm run mcp -- --workspace C:\path\to\project` when troubleshooting.

## Upgrade and maintenance

Run `node scripts/migrate.mjs --project C:\path\to\project` when status reports legacy state. Migration is resumable and non-destructive: it verifies copied objects, publishes a manifest last, and will not automatically delete the source state. See [UPGRADE.md](./UPGRADE.md).

Migration scans at most `10,000` JSON objects. A `stale lock` is automatically reclaimed only after its lease expires and its same-host owner PID is proven dead. Alive, unknown, cross-host, legacy, and invalid owners remain report-only for manual review; age alone never authorizes deletion. This process-liveness contract applies to a local state filesystem; NFS/SMB state roots are not supported for automatic reclaim.

`node scripts/maintenance.mjs --project C:\path\to\project` produces a dry-run plan. Apply only a reviewed, unchanged plan with `--apply`; changed or special objects are skipped or reported, never blindly deleted. Both `status.mjs` and `health.mjs` perform a bounded Gateway probe; status is human-readable while health emits one JSON document. `doctor.mjs` remains offline and verifies configuration plus installed artifacts.

## Safety and limits

Recall text is untrusted context, not instructions. Capture records observable user prompts, tool traces, and available assistant output; it does not invent unavailable IDE content. Hook delivery is fail-open, while retries are bounded and non-retryable failures require manual review. Phase 2 does not silently downgrade state or configuration and will not automatically delete migration sources or quarantine contents.

Hook-triggered Outbox work remains FIFO and serial, with `maxItems=3` inside the 1500 ms flush budget. For backlog processing, `npm run drain -- --project C:\path\to\project` runs one bounded one-shot worker, not a daemon; it does not install or start a scheduler. The default `budget-ms` is 30000, so an external schedule should use an interval of at least 30 seconds (and never shorter than the configured budget) to avoid pointless overlap.

The one-shot drain is serial within each session lane and defaults to 4 concurrent lanes; `--concurrency` can set a bound from 1 to 8. It does not promise strict global FIFO across sessions. A `manual review` or future retry at a lane head is never bypassed. Keep the API Key only in the environment; never place it on the drain command line.
