# Non-goals and overlap analysis

Checked against repository default branch `feat/server_team` at `4dca55c41bf11cb19b49728dbe495c8e05d25abb` (2026-08-11) and the GitHub state observed on 2026-08-12.

## Hard non-goals

- No Memory Core implementation or changes.
- No MemoryProxy implementation, agent adapter, request translation, injection, or write-back.
- No Gateway client or SDK.
- No MCP protocol server or copied tool handlers.
- No lifecycle hooks, session watcher, or automatic capture daemon.
- No implementation of the v2.0.1 Codex IDE Plan-mode adapter.
- No fabricated ChatGPT `.app.json` ID or claim of Work-compatible remote MCP hosting.
- No automatic edits to user `config.toml`, `AGENTS.md`, or credentials.

## Overlap map

| Item | Current state | This PoC's relationship |
| --- | --- | --- |
| #392 | Open; broad Plugin + Python MCP + CLI + hooks + SDK. Maintainer asked it to reuse #316 and split unique value into smaller PRs. | Treat the Plugin packaging as source material to rescope, not a competing stack. None of its MCP/CLI/SDK/hooks are copied. |
| #316 | Open; lightweight Gateway client/adaptor boundary on old `main`. | Do not duplicate. A future official MCP may consume it. |
| #602 | Open, non-mergeable; hardened Gateway SDK on old `main`. | Do not duplicate or import an unmerged Git branch. |
| #603 | Open; official-candidate `memory-tencentdb-mcp` executable, depends on #601/#602, targets old `main`. | This branch ports its tested Gateway client and MCP source into v2 `MemoryCore`; the Plugin only launches that build output. |
| #833 | Open design issue for native OpenCode/Codex MemoryProxy sources plus MCP expansion. | This PoC covers Plugin distribution only. It does not implement Part A or Part D. |
| ROADMAP v2.0.1 | Plans Codex IDE Plan-mode support in MemoryProxy; CLI and non-Plan explicitly unsupported. | Leaves Plan mode to MemoryProxy; offers explicit MCP tools for app/CLI/non-Plan when official MCP exists. |
| #826 | Closed without merge; attempted native Responses session binding on `feat/server_team`. | Confirms native Responses integration is a Proxy concern, not Plugin code to revive here. |

## Stop condition

If upstream accepts an equivalent thin Plugin extracted from #392, this directory should be replaced by that implementation or reduced to missing tests/docs. It must not become a second marketplace entry with the same responsibility.
