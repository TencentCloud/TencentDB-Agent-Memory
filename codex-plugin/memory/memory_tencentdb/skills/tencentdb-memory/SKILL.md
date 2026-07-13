---
name: tencentdb-memory
description: Search the user's persistent memory across four tiers — conversation archive (L0), extracted facts (L1), scene clusters (L2), and persona profile (L3). Use when the user references past context, asks "what did we decide about…", or needs to recall preferences, instructions, or previous conversations.
---

## TencentDB Agent Memory

This project integrates a four-layer local memory system (L0→L1→L2→L3) that automatically captures and organizes conversational knowledge.

### Memory Tiers

| Tier | Name | Description |
|------|------|-------------|
| **L0** | Conversation Archive | Raw conversation turns stored as they happened |
| **L1** | Extracted Facts | Structured memories: user preferences, decisions, instructions, episodic events |
| **L2** | Scenes | Topic clusters grouping related conversations |
| **L3** | Persona | Persistent user profile derived from long-term patterns |

### Automatic Recall and Capture

- **Memory recall happens automatically** before each user prompt via the `UserPromptSubmit` hook. You do NOT need to call memory tools before every response — recalled context is already injected.
- **Memory capture happens automatically** after each turn via the `Stop` hook. You do NOT need to manually save or record conversations.

### When to Use Memory Tools

Only call memory tools when you need to go beyond the automatically-recalled context:

- **Use `tdai_memory_search`** when the user asks about past facts, preferences, decisions, or instructions they have shared. Example queries:
  - "What programming languages does the user prefer?"
  - "What did we decide about the database migration?"
  - "What code style instructions has the user given?"

- **Use `tdai_conversation_search`** when you need to find a specific past conversation or discussion. Example queries:
  - "What did we discuss about the auth system last week?"
  - "Find conversations about the API refactoring"

### Search Result Format

Both tools return results as text. Memory search results include the memory content and type label. Conversation search results include relevant conversation snippets. If no matching results are found, the tools return an empty response — this is normal and means no relevant memories exist yet.

### Guidance

1. Do NOT call memory tools before every response. Recall is automatic.
2. Only search when the user explicitly asks about their past or when the task clearly requires historical context.
3. When in doubt, prefer `tdai_memory_search` over `tdai_conversation_search` — it returns structured, higher-quality results.
4. If both searches return empty, tell the user honestly that no relevant memories were found.
