# Codex Memory Adapter Design

## Goal

Add a Codex-specific memory adapter on top of the shared Gateway adapter from
#316. The adapter provides the minimum automatic read/write loop required by
issue #235 without introducing another Gateway client, adapter SDK, MCP server,
installer, or uninstaller.

## Scope

- `UserPromptSubmit` parses the Codex hook payload, derives a stable
  `sessionKey`, calls `prefetch()`, and returns recalled memory as additional
  context.
- `Stop` obtains the current user prompt and final assistant response, calls
  `captureTurn()`, and clears temporary prompt state after successful capture.
- A file-backed prompt cache bridges the two separately executed hook commands.
- Transcript parsing is used when the prompt cache is unavailable.
- The plugin manifest exposes only Codex hooks. Active memory search remains the
  responsibility of the shared MCP bridge from #372.
- README files document manual configuration, Gateway startup, hook trust,
  verification, disabling, and removal.

## Non-goals

- No new Gateway HTTP client or generic adapter abstraction.
- No Codex-specific MCP server.
- No `searchMemories()`, `searchConversations()`, or `endSession()` wrapper.
- No install or uninstall scripts.
- No automatic Gateway startup.

## Data Flow

1. Codex invokes `UserPromptSubmit` as a command hook.
2. The hook stores the prompt by session id and calls the #316 adapter's
   `prefetch()` method.
3. The shared adapter sends `/recall` to the running TDAI Gateway.
4. The hook writes recalled context to Codex's additional-context output.
5. Codex later invokes `Stop` in a separate process.
6. The hook reads the prompt cache, or falls back to the Codex transcript, and
   calls `captureTurn()` with the user and assistant texts.
7. The shared adapter sends `/capture`; the prompt cache entry is deleted only
   after success.

## Error Handling

Recall and capture failures are fail-open: they are reported to stderr but do
not block Codex. Empty prompts, empty assistant responses, and recursive stop
hook invocations are ignored. Cache entries are bounded by age and keyed by a
sanitized session identifier.

## Verification

Tests cover hook payload parsing, session mapping, additional-context output,
cross-process prompt caching, transcript fallback, successful capture cleanup,
and fail-open Gateway errors. The existing #316 tests remain unchanged and
must continue to pass.
