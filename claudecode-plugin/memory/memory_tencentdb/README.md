# TencentDB Agent Memory for Claude Code

This plugin connects Claude Code lifecycle hooks to the shared Gateway adapter
from #316. `SessionStart` checks Gateway health, `UserPromptSubmit` recalls
relevant memory, `Stop` captures the completed user/assistant turn, and
`SessionEnd` flushes the memory session. It does not add a private MCP Server;
active memory search belongs to the shared MCP bridge from #372.

## Prerequisites

- Node.js 22.16 or later
- Claude Code with plugin and command-hook support
- Repository dependencies installed with `npm install`
- The Gateway model/provider environment configured as described by the root README

Run Claude Code-specific tests from the repository root:

```text
npx.cmd vitest run --config claudecode-plugin/vitest.config.ts
```

## 1. Configure the Gateway connection

For Windows `cmd.exe`:

```bat
set TDAI_GATEWAY_URL=http://127.0.0.1:8420
set TDAI_GATEWAY_API_KEY=replace-with-your-key
```

For PowerShell:

```powershell
$env:TDAI_GATEWAY_URL = "http://127.0.0.1:8420"
$env:TDAI_GATEWAY_API_KEY = "replace-with-your-key"
```

For bash/zsh:

```bash
export TDAI_GATEWAY_URL=http://127.0.0.1:8420
export TDAI_GATEWAY_API_KEY=replace-with-your-key
```

Use the same Bearer token for Gateway and Claude Code. Omit the API key only
when Gateway authentication is disabled.

## 2. Start the Gateway

Start this command from the repository root, and keep the process running:

```text
node --import tsx src/gateway/server.ts
```

Verify the Gateway in another terminal:

```text
curl http://127.0.0.1:8420/health
```

The plugin does not start or stop the Gateway automatically.

## 3. Start Claude Code with the plugin

Claude Code can be started from any project directory. Replace
`<path-to-TencentDB-Agent-Memory>` with the actual checkout path:

```text
claude --plugin-dir "<path-to-TencentDB-Agent-Memory>\claudecode-plugin\memory\memory_tencentdb"
```

For example, run the command while your current directory is the project you
want Claude Code to work on. The plugin path may be absolute even when the
working directory is elsewhere. On macOS or Linux, use the corresponding path
format. When Claude Code asks for Hook approval, review and trust the
`SessionStart`, `UserPromptSubmit`, `Stop`, and `SessionEnd` commands.

## 4. Verify memory activity

Use Claude Code normally. The Gateway terminal should show:

```text
Recall completed in ...ms: context=... chars
Capture completed in ...ms: l0=...
```

At session start and session end, the Gateway receives `/health` and
`/session/end` respectively.

The recall Hook stores the prompt in a short-lived cross-process cache. If the
cache is unavailable during capture, the adapter falls back to the Claude Code
transcript. A failed Gateway request does not block Claude Code.

## 5. Disable the plugin

Stop launching Claude Code with `--plugin-dir`, or close the Claude Code
session and start it without the plugin. Then stop the Gateway terminal if it
is no longer needed. These actions do not delete memories under
`~/.memory-tencentdb`.
