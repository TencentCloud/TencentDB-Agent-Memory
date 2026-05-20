---
name: tdai-memory
description: Use TencentDB Agent Memory from Codex for manual inspection, explicit remembering, and diagnostics. Automatic hooks are the primary path; use this skill only when the user asks about memory state, recall, or saving a specific note.
---

# TDAI Memory For Codex

This plugin is designed to be automatic:

- `SessionStart` injects project memory and recent raw-conversation hints.
- `UserPromptSubmit` starts a turn, recalls relevant L1/L2/L3 memory, and injects it as context.
- If Gateway recall/search has no useful context, prompt recall falls back to a project-scoped local L0 JSONL scan.
- `PreToolUse` injects a lightweight model-visible memory hint and collects tool activity.
- `PermissionRequest` / `PostToolUse` collect permission and tool result activity.
- Large `PostToolUse` results are offloaded into `context-offload/<session>/offload-*.jsonl`, `refs/*.md`, and `mmds/001-codex-tool-offload.mmd`; later prompts inject the compact canvas.
- `PreCompact` captures pending turn state before compaction.
- `PostCompact` flushes session-scoped memory pipeline work through `/session/end`.
- `Stop` captures the completed turn through the TencentDB Agent Memory Gateway and flushes every `TDAI_CODEX_FLUSH_EVERY_N_TURNS` turns.
- Adapter-controlled capture and import paths strip injected TencentDB/Codex memory tags before persistence, matching the original `before_message_write` cleanup goal even though Codex does not expose that exact hook.
- `tdai_memory_search` / `tdai_conversation_search` / `tdai_offload_lookup` are available as Codex MCP tools when `scripts/mcp-server.mjs` is registered.

Manual commands are only for inspection or explicit notes:

```bash
node "${PLUGIN_ROOT}/scripts/query.mjs" status
node "${PLUGIN_ROOT}/scripts/query.mjs" memory "query terms"
node "${PLUGIN_ROOT}/scripts/query.mjs" conversation "query terms"
node "${PLUGIN_ROOT}/scripts/query.mjs" remember "durable note to save"
node "${PLUGIN_ROOT}/scripts/query.mjs" flush
node "${PLUGIN_ROOT}/scripts/query.mjs" seed ./historical-conversations.json
node "${PLUGIN_ROOT}/scripts/query.mjs" offload list --all --limit 10
node "${PLUGIN_ROOT}/scripts/query.mjs" offload node Cxxxxxx_N001 --content
```

When memory is retrieved, use it as operating context. Verify path- and data-dependent claims against the current filesystem before acting. If current evidence contradicts memory, trust the current evidence and save the correction.
