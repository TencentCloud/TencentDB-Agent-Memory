# Upstream proposal drafts

These are drafts only. Confirm the desired relationship to #392 and the target branch with maintainers before opening a PR.

## Pull request title

`feat(plugin): add Codex lifecycle integration for Agent Memory v2`

## Pull request body

### Summary

Add a Codex integration Plugin for TencentDB Agent Memory v2. The initial #953
rescope was too aggressive: it removed Codex lifecycle hooks together with the
duplicated shared adapter stack. #392 maintainer triage asked platform-specific
hooks to be split behind the shared Gateway client boundary; it did not reject
them. This revision restores only that narrow host integration layer:

- standard `.codex-plugin/plugin.json` manifest and repo marketplace entry;
- a Skill that explains automatic recall/capture, safe read/write memory use, and surface boundaries;
- four fail-open Codex hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`) with exactly-once pending-turn capture;
- a shared identity resolver and atomic plugin state under `PLUGIN_DATA`;
- the v2 port of #603's tested Gateway client and `memory-tencentdb-mcp` executable, reused by hooks and MCP;
- `.mcp.json` wiring that launches the v2 MemoryCore build output;
- non-secret setup and health checks for the MCP executable, MemoryCore Gateway, and optional MemoryProxy;
- compatibility notes for Codex app/CLI/non-Plan, Codex IDE Plan mode, and ChatGPT Chat/Work.

### Non-goals

The Plugin contains no Memory Core/storage/extraction implementation, second
public SDK, second MCP protocol server, session watcher, or MemoryProxy/#833
AgentKind/Responses/IDE adapter. It does not add a raw arbitrary HTTP MCP tool
or fabricated ChatGPT `.app.json` registration. The hook runner is a narrow
Codex lifecycle adapter and imports the same MemoryCore Gateway client as MCP.

### Overlap and dependency analysis

- #392 contains useful Plugin packaging plus parallel MCP/CLI/SDK/hooks. Maintainer triage asked it to reuse #316 and split unique platform value into smaller PRs. This proposal is the Codex-hook/MCP slice behind the shared v2 boundary, not a competing adapter stack.
- #316 closed on 2026-08-12 without merge; #602 remains open. Neither is imported as an unmerged branch or duplicated as a second public SDK.
- #603 remains the official-candidate stdio MCP implementation and depends on #601/#602. This PR ports that implementation to the current v2 package layout, keeps its focused five-tool baseline, and stages the operation registry/curated expansion separately.
- #833 and the v2.0.1 Roadmap own native MemoryProxy integration. The Roadmap limits it to Codex IDE Plan mode; this Plugin leaves that path untouched and supplies explicit MCP tools for Plugin-capable Codex surfaces.
- #826 was closed without merge and confirms that native Responses session binding belongs in MemoryProxy rather than this package.

### Verification status for this revision

- Plugin and hook tests: passed in the controlled local environment (14 passed,
  1 skipped; the skip is repository-build discovery because
  `MemoryCore/dist/memory-tencentdb-mcp.mjs` is not present in this checkout).
- Manifest, hook, MCP-config, and Skill contract checks: passed.
- `node --check` for the hook runner and state helper: passed.
- `git diff --check`: passed.
- MemoryCore TypeScript/Vitest/build verification: pending because this checkout
  does not currently have `MemoryCore/node_modules` or the required local
  toolchain installed. These results must be refreshed before claiming the
  shared client, MCP registry, or build artifacts are upstream-ready.

### Maintainer questions

1. Should the operation registry and expanded curated MCP read surface stay as the next slice of #953 or land as a follow-up?
2. Which trusted deployment should supply the explicit service/instance/team/agent/user identity for hosted use?
3. Should a future hosted MCP registration for ChatGPT Work live in this repository or in a separate deployment/integration repository?

## Suggested #833 comment

I reviewed the current v2 default branch, Roadmap, and the overlapping work in
#392/#316/#602/#603 (plus the closed #826 native Responses attempt). The
revised #953 scope is a **Codex integration Plugin**, not a packaging-only
wrapper: it restores the four narrow Codex lifecycle hooks, keeps the focused
five-tool MCP baseline, and adds the shared identity/state and public-route
registry needed to make those surfaces consistent.

The implementation still leaves Memory Core business logic, transport, and
authorization in their existing shared boundaries. It does not add a second
SDK, raw arbitrary HTTP tool, MemoryProxy AgentKind/Responses adapter, or
fabricated ChatGPT Work registration. The next reviewable slice is typed
read-only expansion (L2/L3, Skill, and Knowledge), followed by separately
reviewed write/admin surfaces. Would maintainers prefer that staged sequence in
#953, or split the typed MCP expansion into a follow-up after the hook and
registry slice?
