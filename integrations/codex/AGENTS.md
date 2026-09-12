# Agent Operating Instructions

## Memory System

TencentDB Agent Memory is available through MCP tools:

- `tdai_recall`
- `tdai_memory_search`
- `tdai_conversation_search`
- `tdai_capture`
- `tdai_session_end`

Treat TencentDB Agent Memory as the primary long-term memory system for cross-session project knowledge, user preferences, repository conventions, implementation decisions, debugging history, and workflow constraints.

Do not assume that prior context is already present in the current conversation. Use memory tools explicitly.

## Session Key

Use the current repository root path as the default `session_key`.

If no repository is available, use the current working directory as `session_key`.

Use the same `session_key` consistently for all memory operations within one task.

## Start-of-Task Protocol

At the beginning of every non-trivial task, before editing files or running commands:

1. Call `tdai_recall`.
2. Use the user's current request as the `query`.
3. Use the repository root path as `session_key`.
4. Read the returned memory before planning or modifying code.

A task is non-trivial if it involves any of the following:

- code changes
- debugging
- architecture decisions
- dependency changes
- test strategy
- repository-specific conventions
- deployment or build behavior
- user preferences
- multi-step investigation

For trivial tasks, such as answering a simple question about visible code or formatting a short snippet, memory recall is optional.

## Memory Search Protocol

Use `tdai_memory_search` when looking for durable structured knowledge, including:

- project conventions
- previous architectural decisions
- recurring user preferences
- known pitfalls
- preferred libraries or frameworks
- testing/build/deployment commands
- long-term repo-specific facts

Use `tdai_conversation_search` when exact historical evidence is needed, including:

- what was previously discussed
- why a decision was made
- prior debugging traces
- previous commands or tool outputs
- original wording from earlier sessions

Prefer `tdai_recall` first. Use search tools only when recall is insufficient or when more precise evidence is needed.

## During Work

When memory conflicts with the current repository state, trust the repository state.

When memory conflicts with explicit user instructions, trust the user's current instruction.

When memory is stale, incomplete, or ambiguous, say so and proceed from current evidence.

Do not blindly follow recalled memory. Validate it against files, tests, and current task requirements.

## Capture Protocol

At the end of every meaningful task, call `tdai_capture`.

Store a concise but useful summary.

The `user_content` should summarize what the user asked.

The `assistant_content` should include:

- what was changed
- important files touched
- commands run
- tests run and results
- bugs found
- decisions made
- constraints discovered
- repository conventions learned
- unresolved follow-ups
- anything that would help a future Codex session continue efficiently

Keep the capture factual and compact.

Do not store noisy step-by-step logs unless they are diagnostically important.

## Sensitive Information Policy

Never store the following in memory:

- API keys
- access tokens
- passwords
- private keys
- SSH keys
- cookies
- session tokens
- secrets from `.env` files
- personal identification data unless explicitly required and safe
- proprietary credentials
- raw production data
- security-sensitive exploit details

If a task involves secrets, store only a sanitized summary.

Good example:

```text
Configured authentication flow. Secret values are stored in environment variables and were not recorded.
```

Bad example:

```text
Configured authentication using API key sk-...
```
