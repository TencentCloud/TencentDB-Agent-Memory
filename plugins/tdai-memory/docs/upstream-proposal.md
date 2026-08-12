# Upstream proposal drafts

These are drafts only. Confirm the desired relationship to #392 and the target branch with maintainers before opening a PR.

## Pull request title

`feat(plugin): add thin OpenAI/Codex packaging for v2`

## Pull request body

### Summary

Add a deliberately thin OpenAI/Codex Plugin distribution layer for TencentDB Agent Memory v2:

- standard `.codex-plugin/plugin.json` manifest and repo marketplace entry;
- a Skill that explains safe read/write memory tool use and surface boundaries;
- a v2 port of #603's tested Gateway client and `memory-tencentdb-mcp` executable;
- `.mcp.json` wiring that launches the v2 MemoryCore build output;
- non-secret setup and health checks for the MCP executable, MemoryCore Gateway, and optional MemoryProxy;
- compatibility notes for Codex app/CLI/non-Plan, Codex IDE Plan mode, and ChatGPT Chat/Work.

### Non-goals

The Plugin itself contains no Memory Core, MemoryProxy, Gateway client, MCP protocol implementation, lifecycle hooks, session watcher, or v2.0.1 Codex IDE Plan-mode adapter. The only lower-layer code in this PR is a mechanical v2 port of #603's reviewed Gateway client and MCP executable so the package is runnable on the current branch. It does not add a fabricated ChatGPT `.app.json` registration.

### Overlap and dependency analysis

- #392 already contains useful Plugin packaging, but also carries parallel MCP/CLI/SDK/hooks. Maintainer triage asked it to reuse #316 and split unique platform value into smaller PRs. This proposal is intended as that packaging-only rescope, not a competing adapter stack.
- #316 and #602 remain the Gateway-client/SDK work; none is duplicated here.
- #603 remains the official-candidate stdio MCP implementation and depends on #601/#602. This PR ports that implementation to the current v2 package layout without changing its five-tool contract.
- #833 and the v2.0.1 Roadmap own native MemoryProxy integration. The Roadmap limits it to Codex IDE Plan mode; this Plugin leaves that path untouched and supplies explicit MCP tools for Plugin-capable Codex surfaces.
- #826 was closed without merge and confirms that native Responses session binding belongs in MemoryProxy rather than this package.

### Verification

- Plugin tests: 9 passed.
- Gateway/MCP tests ported from #603: 19 passed.
- Codex Plugin validator: passed.
- Agent Skill validator: passed.
- `git diff --check`: passed.
- A real MCP process completed initialize, tools/list, memory_search, and conversation_search against an existing v2 Gateway; both Gateway and MemoryProxy health probes returned `ok`.
- `npm run build:plugin` passed. The repository's broader `npm run build` still reaches a pre-existing missing `scripts/seed-v2/tsconfig.json` after all plugin/MCP artifacts build successfully.

### Maintainer questions

1. Should this packaging-only change be submitted as a split/rescope of #392 or as a small new PR against `feat/server_team`?
2. Should the #603 port remain in this PR or land first as a separate v2 MCP PR?
3. Should a future hosted MCP registration for ChatGPT Work live in this repository or in a separate deployment/integration repository?

## Suggested #833 comment

I reviewed the current v2 default branch, Roadmap, and the overlapping work in #392/#316/#602/#603 (plus the closed #826 native Responses attempt). I have a small PoC for a **packaging-only OpenAI/Codex Plugin** that intentionally does not implement Part A or Part D of this issue.

Its Plugin scope is limited to a standard manifest + Skill, `.mcp.json` delegation, and non-secret setup/health checks. To make it runnable on v2, I ported #603's already-tested Gateway client and five-tool stdio MCP implementation into the current `MemoryCore` package layout instead of creating a parallel server. It leaves the v2.0.1 Codex IDE Plan-mode adapter entirely to MemoryProxy. ChatGPT Work remains documented as requiring a registered hosted MCP service; the PoC does not invent an `.app.json` ID.

The live read-only check completed MCP initialize, tools/list, memory_search, and conversation_search against an existing v2 Gateway. Would maintainers prefer this as one small usable Plugin PR, or split the mechanical #603-to-v2 port from the packaging PR?
