# TencentDB Agent Memory for OpenCode: User Guide

English | [简体中文](USER_GUIDE_CN.md)

The adapter is currently under PR review and has not been published to npm. This guide uses a source installation: fill in one `.env` file, then let OpenCode perform the installation. It does not require `npx`, `npm pack`, or a `.tgz` archive.

## You only need two steps

### Step 1: create and fill in `.env`

Open PowerShell:

```powershell
# Replace <repository-directory> with the actual TencentDB-Agent-Memory download location
cd "<repository-directory>\MemoryCore"
notepad .env.opencode.local
```

If Notepad asks to create the file, choose Yes, then paste:

```dotenv
# Local Gateway port
TDAI_GATEWAY_PORT=18420

# Optional isolated data directory; leave empty for the Gateway default
TDAI_GATEWAY_DATA_DIR=

# May remain empty for L0; fill these for L1/L2/L3 or Skill
TDAI_LLM_API_KEY=
TDAI_LLM_BASE_URL=https://api.openai.com/v1
TDAI_LLM_MODEL=gpt-4o-mini

# Skill requires a working LLM configuration
TDAI_SKILL_ENABLED=false

# Optional: fill only for vector or hybrid semantic retrieval
TDAI_EMBEDDING_API_KEY=
TDAI_EMBEDDING_BASE_URL=
TDAI_EMBEDDING_MODEL=
TDAI_EMBEDDING_DIMENSIONS=1536
```

Change the URL, model, and keys for your provider, then save and close Notepad. Never put model secrets in chat, `opencode.json`, or project source files.

Basic memory works even when every model key is empty:

| Feature | Model key required? |
|---|---|
| L0 conversation capture and cross-session recall | No |
| Active conversation-history search | No |
| OpenCode plugin installation | No |
| Automatic L1 atomic-memory extraction | LLM key |
| L2/L3 scenes and user profiles | LLM key |
| Skill learning and retrieval | LLM key |
| Vector or hybrid semantic retrieval | Embedding key |

When Embedding is empty, search uses BM25. Secrets remain only in the Gateway-side `.env.opencode.local`, which Git ignores.

`TDAI_GATEWAY_DATA_DIR` is useful for tests or a fully separate memory store. It may be an absolute path; auto-install generates a private runtime configuration without modifying the repository's Gateway YAML.

On macOS/Linux, enter `<repository-directory>/MemoryCore` and create the same file with a local editor, for example `${EDITOR:-nano} .env.opencode.local`; its contents are identical.

### Step 2: hand the installation to OpenCode

The source auto-install flow below has completed end-to-end acceptance on Windows PowerShell 7. The adapter runtime itself supports macOS/Linux, but those platforms must not copy the task's Windows background-process installation steps yet.

Open the `TencentDB-Agent-Memory` repository in OpenCode and send this entire message to the model:

```text
Read adapters/opencode/SELF_INSTALL.md and execute every step in order until its completion criteria are met. I have filled in MemoryCore/.env.opencode.local; parse it only inside a local process that produces no output, and never display or ask me to send any secret from it. Do not merely explain the commands—perform the checks, build, source installation, Gateway startup, and verification. Preserve all existing repository changes.
```

The model will automatically:

- Automatically locate Node.js 22.16+ required by the Gateway, including common WorkBuddy/Codex runtimes, and check repository and `.env` safety
- Reuse or restart a local Gateway only when process ownership is verified; an unknown Gateway stops installation with a choose-another-port message and is never terminated
- Install dependencies and run the adapter checks
- Make OpenCode load this repository's build directly
- Create a private plugin configuration without model secrets
- Verify that the Gateway, loader, and configuration agree

Do not close the current OpenCode task during installation. After the model reports the real result, fully quit and reopen OpenCode.

## Verify after restarting

Send:

```text
Call the tdai_memory_status tool. Do not explain its name or use Shell. Return only the tool result.
```

The plugin is loaded when the Gateway is reachable, isolation is configured, and recall/capture are enabled. `0 atomic memories` only means no L1 memory has been generated yet; it is not an installation failure.

## Everyday use

Chat normally; completed turns are captured automatically. For example:

```text
Remember that I prefer TypeScript strict mode and avoid any.
```

In a new session, ask:

```text
What are my TypeScript preferences?
```

For an exact search, say:

```text
Use tdai_memory_search to find my earlier database-migration decision.
```

## Common messages

- `npm E404`: do not run the unpublished `npx @tencentdb-agent-memory/opencode-adapter`; ask OpenCode to execute the source-install task above again.
- `timeout 5000ms`: this is the per-request Gateway timeout limit, not a statement that a timeout already occurred. Investigate Gateway logs or raise it only when a request actually fails.
- `Skill module not enabled`: Skill is not enabled on both the Gateway and plugin. Set `TDAI_SKILL_ENABLED=true` in `.env` and rerun the automated installation task.
- `0 atomic memories`: L1 has not extracted an atomic memory yet. L0 capture, history search, and cross-session recall still work.
