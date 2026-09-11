# TencentDB Agent Memory for Codex

This plugin connects Codex lifecycle hooks to the shared TDAI Gateway adapter
from #316. `UserPromptSubmit` automatically recalls relevant memory, and `Stop`
captures the completed user/assistant turn. Model-initiated memory search is not
implemented here; it is provided separately by the shared MCP bridge from #372.

## Prerequisites

- Node.js 22.16 or later
- Codex CLI with plugin support
- Repository dependencies installed with `npm install`
- The TDAI Gateway model/provider environment configured as described by the
  repository root README

Run Codex-specific tests from the repository root with:

```text
npx.cmd vitest run --config codex-plugin/vitest.config.ts
```

## 1. Configure the Gateway connection

The Gateway and Codex hooks must use the same optional Bearer token. For
Windows `cmd.exe`:

```bat
set TDAI_GATEWAY_URL=http://127.0.0.1:8420
set TDAI_GATEWAY_API_KEY=replace-with-your-key
set TDAI_MEMORY_ROOT=.
```

For PowerShell:

```powershell
$env:TDAI_GATEWAY_URL = "http://127.0.0.1:8420"
$env:TDAI_GATEWAY_API_KEY = "replace-with-your-key"
$env:TDAI_MEMORY_ROOT = "."
```

For bash/zsh:

```bash
export TDAI_GATEWAY_URL=http://127.0.0.1:8420
export TDAI_GATEWAY_API_KEY=replace-with-your-key
export TDAI_MEMORY_ROOT=.
```

`TDAI_MEMORY_ROOT` must point to the repository root. The examples use `.`;
start Codex from the repository root so installed hooks can reuse the shared
#316 source instead of bundling another adapter. Omit
`TDAI_GATEWAY_API_KEY` only when Gateway authentication is disabled. Start Codex
from an environment containing these variables. When using the Codex desktop
app on Windows, persistent variables set with `setx` take effect after the app
is fully restarted.

## 2. Start the Gateway

Run this command from the repository root and keep the terminal open:

```text
node --import tsx src/gateway/server.ts
```

Verify it in another terminal:

```text
curl http://127.0.0.1:8420/health
```

When authentication is enabled, add `Authorization: Bearer <your-key>` to the
health request.

## 3. Configure the local Codex marketplace

Run the following command from the repository root to point Codex at the local
`codex-plugin` directory:

The directory contains the Marketplace manifest at
`.agents/plugins/marketplace.json`; keep this layout unchanged.

```text
codex plugin marketplace add .\codex-plugin
codex plugin add tencentdb-memory@tencentdb-agent-memory-local
```

Confirm the plugin is visible:

```text
codex plugin list
```

Restart Codex or open a new task, then review and trust the two command hooks
when Codex prompts for approval. Do not bypass hook trust globally.

## 4. Use memory in Codex

Use Codex normally. Each user prompt triggers `/recall`; the returned context
is supplied as additional context. When the turn finishes, the `Stop` hook
sends the user prompt and final assistant response to `/capture`.

The Gateway terminal should show requests to `/recall` and `/capture`. If it
does not, check that the plugin is enabled, the hooks are trusted, and Codex
inherited `TDAI_GATEWAY_URL` and `TDAI_GATEWAY_API_KEY`.

## Disable or remove

Disable memory without deleting stored TDAI data:

```text
codex plugin remove tencentdb-memory@tencentdb-agent-memory-local
```

To stop using the local marketplace as well:

```text
codex plugin marketplace remove tencentdb-agent-memory-local
```

Finally stop the terminal running `src/gateway/server.ts`. These commands do
not delete memories under `~/.memory-tencentdb`.
