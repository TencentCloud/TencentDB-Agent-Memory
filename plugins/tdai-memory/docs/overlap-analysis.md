# Non-goals and overlap analysis

Checked against repository default branch `feat/server_team` at `4dca55c41bf11cb19b49728dbe495c8e05d25abb` (2026-08-11) and the GitHub state observed on 2026-08-12.

## Boundary after the #953 scope correction

The initial packaging-only rescope was too aggressive. #392's maintainer triage
asked contributors to reuse the shared Gateway client boundary and split
platform-specific value such as Codex/Claude hooks into smaller PRs; it did not
reject those hooks. This PR now owns the narrow Codex lifecycle hook layer and
continues to leave shared business logic in MemoryCore.

## Hard non-goals

- No Memory Core business implementation, storage, or extraction changes. The
  shared Gateway client boundary, route catalog, and MCP integration exports
  may be extended in MemoryCore because they are the single implementation
  reused by this Plugin; that work must not become a second public SDK.
- No MemoryProxy implementation, agent adapter, request translation, injection, or write-back.
- No second Gateway client, SDK, or public adapter framework. Hooks and MCP
  import the shared MemoryCore Gateway client.
- No second MCP protocol server or copied tool handlers.
- No session watcher or background capture daemon. The four hooks run only on
  the Codex lifecycle events declared in `hooks/hooks.json`.
- No implementation of the v2.0.1 Codex IDE Plan-mode adapter.
- No fabricated ChatGPT `.app.json` ID or claim of Work-compatible remote MCP hosting.
- No automatic edits to user `config.toml`, `AGENTS.md`, or credentials.

## Overlap map

| Item | Current state | This PoC's relationship |
| --- | --- | --- |
| #392 | Open; broad Plugin + Python MCP + CLI + hooks + SDK. Maintainer asked it to reuse #316 and split unique value into smaller PRs. | Treat the Plugin packaging as source material to rescope, not a competing stack. None of its MCP/CLI/SDK/hooks are copied. |
| #316 | Closed on 2026-08-12 without merge; lightweight Gateway client/adaptor boundary on old `main`. | Do not duplicate its boundary; this branch carries the v2 shared client already present in MemoryCore. |
| #602 | Open; hardened Gateway SDK on old `main`. | Do not duplicate or import an unmerged Git branch; keep this PR's shared client boundary narrow. |
| #603 | Open; official-candidate `memory-tencentdb-mcp` executable, depends on #601/#602, targets old `main`. | This branch ports its tested Gateway client and MCP source into v2 `MemoryCore`; the Plugin only launches that build output. |
| #833 | Open design issue for native OpenCode/Codex MemoryProxy sources plus MCP expansion. | This PR covers Codex Plugin + hooks + curated MCP; it does not implement AgentKind, Responses proxy, or IDE routing. |
| ROADMAP v2.0.1 | Plans Codex IDE Plan-mode support in MemoryProxy; CLI and non-Plan explicitly unsupported. | Leaves Plan mode to MemoryProxy; offers explicit MCP tools for app/CLI/non-Plan when official MCP exists. |
| #826 | Closed without merge; attempted native Responses session binding on `feat/server_team`. | Confirms native Responses integration is a Proxy concern, not Plugin code to revive here. |

## Stop condition

If upstream accepts an equivalent Plugin extracted from #392, this directory
should be replaced by that implementation or reduced to missing tests/docs. It
must not become a second marketplace entry with the same responsibility. The
operation registry is an internal route catalog, not permission to grow a
second SDK.
